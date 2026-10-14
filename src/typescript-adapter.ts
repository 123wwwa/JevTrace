import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import type { CodeNode, Dependency, DependencyScan, EdgeKind, EntryInput, LanguageAdapter, SourceLocation, SupportingContext, Unresolved } from './types.js';
import { parseProjectConfigs, selectProjectFromParsed, type ParsedProjectConfig } from './project-config.js';
import { isVueFile, scriptText, vueScript } from './vue.js';
import { readDirectory } from './fs-walk.js';
import { UserFacingError } from './errors.js';

const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.vue']);
const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
function collectSources(dir: string, files: string[]): void {
  for (const entry of readDirectory(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.')) collectSources(full, files);
    else if (entry.isFile() && extensions.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) files.push(full);
  }
}
/** Root files of a repository without a tsconfig/jsconfig; above this many, only the entry's surroundings are roots. */
const maxUnconfiguredRoots = 5000;
/** How long the unconfigured file list is reused before the directory tree is walked again. */
const unconfiguredListMs = 10_000;
/**
 * Every source file, or for a large repository the files under the entry's highest ancestor directory that
 * holds at most `maxUnconfiguredRoots` of them. Files outside that directory the roots import are still loaded
 * through module resolution; only their callers outside it are not searched.
 */
function unconfiguredScope(root: string, all: string[], entry: string): { directory: string; files: string[] } {
  if (all.length <= maxUnconfiguredRoots) return { directory: root, files: all };
  const under = (directory: string) => all.filter(file => file.startsWith(directory + path.sep));
  let directory = path.dirname(entry);
  let files = under(directory);
  for (let parent = path.dirname(directory); parent.startsWith(root) && parent !== directory; parent = path.dirname(parent)) {
    const wider = under(parent);
    if (wider.length > maxUnconfiguredRoots) break;
    directory = parent;
    files = wider;
    if (parent === root) break;
  }
  return { directory, files: files.length ? files : [entry] };
}
function declaration(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) || ts.isPropertyDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node)) return node.parent.parent;
  return undefined;
}
function named(node: ts.Node): string | undefined { return (node as ts.NamedDeclaration).name?.getText(); }
/** The identifier that names a declaration unit; a `const f = () => …` statement is named by its variable. */
function declarationName(node: ts.Node): ts.Node | undefined {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name;
  if (ts.isConstructorDeclaration(node)) return (node.parent as ts.ClassDeclaration).name;
  return (node as ts.NamedDeclaration).name;
}
/** `Class.member` for class members (the form discovery and the benchmark labels use), the plain name otherwise. */
function qualifiedName(node: ts.Node, fallback: string): string {
  const own = ts.isConstructorDeclaration(node) ? 'constructor' : declarationName(node)?.getText() ?? fallback;
  const parts = [own];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name) parts.unshift(parent.name.getText());
  }
  return parts.join('.');
}
/** The innermost node containing a position. */
function nodeAt(source: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (current: ts.Node) => {
    if (position < current.getStart(source) || position >= current.getEnd()) return;
    found = current;
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}
const clip = (text: string, max = 48) => {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/**
 * A readable name for an anonymous function from where it sits, e.g. `registerTool('retrieve') callback`,
 * `app.ontoolresult handler` or `options.onError`, instead of an opaque placeholder.
 */
function callbackName(fn: ts.Node): string {
  const parent = fn.parent;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const label = parent.arguments?.find(argument => ts.isStringLiteralLike(argument));
    const callee = clip(parent.expression.getText(), 40);
    return `${callee}(${label ? `'${clip((label as ts.StringLiteralLike).text, 40)}'` : ''}) callback`;
  }
  if (ts.isBinaryExpression(parent) && parent.right === fn) return `${clip(parent.left.getText())} handler`;
  if (ts.isPropertyAssignment(parent)) {
    const holder = parent.parent.parent;
    const owner = holder && ts.isVariableDeclaration(holder) ? `${holder.name.getText()}.` : '';
    return `${owner}${clip(parent.name.getText())}`;
  }
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
    const outer = callerOwner(parent.parent ?? parent);
    if (outer) return `${outer.name} (returned function)`;
  }
  return '<anonymous function>';
}

function callerOwner(node: ts.Node): { node: ts.Node; name: string } | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isGetAccessor(current)
        || ts.isSetAccessor(current) || ts.isConstructorDeclaration(current)) {
      return { node: current, name: qualifiedName(current, '<anonymous function>') };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) return { node: parent.parent.parent, name: parent.name.getText() };
      if (ts.isPropertyDeclaration(parent)) return { node: parent, name: qualifiedName(parent, '<anonymous function>') };
      return { node: current, name: callbackName(current) };
    }
    current = current.parent;
  }
  return undefined;
}
/** The function a declaration unit defines: a function or method, or a `const`/property holding an arrow or function expression. */
function functionOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) return node;
  const initializer = ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.initializer
    : ts.isPropertyDeclaration(node) ? node.initializer : undefined;
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : undefined;
}
/** Bound on argument-source edges per function: a widely called helper should not pull in every caller's data. */
const maxArgumentSources = 6;
/** Bounds on shared-reader edges: values read per lead, readers per value, readers in all, and the use count above which a value is a hub. */
const maxSharedSymbols = 8;
const maxSharedPerSymbol = 3;
const maxSharedEdges = 6;
const maxSharedReferences = 40;
/** A property of `Object.freeze({…})` or another mapped type is a synthetic symbol with no value declaration; its declarations still point at the source. */
const declarationOf = (symbol: ts.Symbol | undefined): ts.Declaration | undefined => symbol?.valueDeclaration ?? symbol?.declarations?.[0];
const isEnumMember = (symbol: ts.Symbol | undefined): boolean => symbol?.valueDeclaration !== undefined && ts.isEnumMember(symbol.valueDeclaration);
/** A top-level `const` holding data (not a function or class): a threshold, a lookup table, a configuration object. */
function moduleDataConstant(declaration: ts.Node): boolean {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
  const statement = declaration.parent.parent;
  const initializer = declaration.initializer;
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)
    && !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer));
}
/** A key of a module-level configuration object, also inside `as const` or `Object.freeze({…})`: `CONFIG.grenade.range`. */
function configurationKey(declaration: ts.Node): boolean {
  if (!ts.isPropertyAssignment(declaration) && !ts.isShorthandPropertyAssignment(declaration)) return false;
  let current: ts.Node = declaration.parent;
  while (ts.isObjectLiteralExpression(current) || ts.isPropertyAssignment(current) || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current) || ts.isCallExpression(current)) current = current.parent;
  return moduleDataConstant(current);
}
const isTestFile = (file: string): boolean =>
  /(?:^|[/.])(?:__tests__|test|tests|spec)(?:[/.]|$)/i.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
/** Language services kept warm across tsconfig projects; switching back to a recent project reuses its program. */
const maxWarmProjects = 4;
/**
 * A class's shape without its implementation: the heading plus one line per member (method and accessor
 * signatures, property declarations). What an agent needs from a large class it only constructs or types against.
 */
const outlineMembers = 40;
function classOutline(node: ts.ClassDeclaration, source: ts.SourceFile): string {
  const text = source.text;
  const heading = text.slice(node.getStart(source), node.members.pos).trim().replace(/\{$/, '').trim();
  const members = node.members.slice(0, outlineMembers).map(member => {
    const start = member.getStart(source);
    const body = ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)
      ? member.body : undefined;
    const head = body ? text.slice(start, body.getStart(source)) : text.slice(start, member.getEnd());
    const line = head.replace(/\s+/g, ' ').trim().replace(/[{;]$/, '').trim();
    return `  ${line.length > 160 ? `${line.slice(0, 159)}…` : line};`;
  });
  const more = node.members.length > outlineMembers ? [`  // … ${node.members.length - outlineMembers} more members`] : [];
  return [`${heading} {`, ...members, ...more, '}'].join('\n');
}

function signature(node: ts.Node, source: ts.SourceFile): string {
  // A Vue component's setup, used as a caller (see componentOwner).
  if (ts.isSourceFile(node)) return `<script setup> of ${path.basename(node.fileName)}`;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
    return source.text.slice(node.getStart(source), node.body ? node.body.getStart(source) : node.getEnd()).trim();
  if (ts.isClassDeclaration(node)) return classOutline(node, source);
  if (ts.isVariableStatement(node)) return source.text.slice(node.getStart(source), Math.min(node.getEnd(), node.getStart(source) + 240)).split('\n')[0];
  return source.text.slice(node.getStart(source), Math.min(node.getEnd(), node.getStart(source) + 500));
}

export class TypeScriptAdapter implements LanguageAdapter {
  readonly language = 'javascript-typescript';
  private program?: ts.Program;
  private checker?: ts.TypeChecker;
  private projectKey?: string;
  private service?: ts.LanguageService;
  private readonly services = new Map<string, ts.LanguageService>();
  private readonly scanCache = new WeakMap<ts.Program, Map<string, DependencyScan>>();
  private readonly projectConfigs: ParsedProjectConfig[];
  private unconfigured?: { at: number; files: string[] };
  constructor(readonly root: string) {
    this.projectConfigs = parseProjectConfigs(root).projects;
  }

  findEntry(input: EntryInput): CodeNode {
    const absolute = this.safePath(input.file);
    this.loadProgram(absolute);
    const source = this.program!.getSourceFile(absolute);
    if (!source) throw new UserFacingError(`File is not in its TypeScript project: ${input.file}`);
    const matches: Array<{ node: ts.Node; name: string }> = [];
    const visit = (node: ts.Node, parents: string[]) => {
      const name = named(node);
      const current = name ? [...parents, name] : parents;
      const candidate = declaration(node);
      if (candidate && !(ts.isVariableStatement(candidate) && candidate.parent !== source)) {
        const start = source.getLineAndCharacterOfPosition(candidate.getStart(source)).line + 1;
        const end = source.getLineAndCharacterOfPosition(candidate.getEnd()).line + 1;
        const locationMatch = input.line !== undefined && start <= input.line && end >= (input.endLine ?? input.line);
        const symbolMatch = input.symbol !== undefined && (current.join('.') === input.symbol || name === input.symbol);
        if (locationMatch || (input.line === undefined && symbolMatch)) matches.push({ node: candidate, name: current.join('.') || name || '<anonymous>' });
      }
      ts.forEachChild(node, child => visit(child, ts.isClassDeclaration(node) && name ? current : parents));
    };
    visit(source, []);
    if (!matches.length) throw new UserFacingError(`No declaration found at ${input.file}:${input.line ?? input.symbol}`);
    matches.sort((a, b) => (a.node.getEnd() - a.node.getStart(source)) - (b.node.getEnd() - b.node.getStart(source)));
    if (input.line === undefined && matches.length > 1) throw new UserFacingError(`Symbol ${input.symbol} is ambiguous; supply a line`);
    return this.toCodeNode(matches[0].node, matches[0].name);
  }

  dependencies(node: CodeNode, options: { values?: boolean } = {}): DependencyScan {
    if (!node.external) this.loadProgram(this.safePath(node.file));
    const values = options.values === true;
    return this.cachedScan(`forward:${values ? 'values:' : ''}${node.id}`, () => this.scanDependencies(node, values));
  }

  reverseDependencies(node: CodeNode): DependencyScan {
    if (!node.external) this.loadProgram(this.safePath(node.file));
    return this.cachedScan(`reverse:${node.id}`, () => this.scanReverseDependencies(node));
  }

  argumentSources(node: CodeNode): DependencyScan {
    if (node.external) return { edges: [], unresolved: [] };
    this.loadProgram(this.safePath(node.file));
    return this.cachedScan(`arguments:${node.id}`, () => this.scanArgumentSources(node));
  }

  sharedReaders(node: CodeNode): DependencyScan {
    if (node.external) return { edges: [], unresolved: [] };
    this.loadProgram(this.safePath(node.file));
    return this.cachedScan(`shared:${node.id}`, () => this.scanSharedReaders(node));
  }

  /** Scans are memoized per Program: any edited file yields a new Program and therefore a fresh cache. */
  private cachedScan(key: string, scan: () => DependencyScan): DependencyScan {
    const program = this.program;
    let scans = program && this.scanCache.get(program);
    if (program && !scans) this.scanCache.set(program, scans = new Map());
    let result = scans?.get(key);
    if (!result) {
      result = scan();
      scans?.set(key, result);
    }
    return { edges: [...result.edges], unresolved: [...result.unresolved] };
  }

  private scanDependencies(node: CodeNode, values: boolean): DependencyScan {
    const source = this.program?.getSourceFile(path.resolve(this.root, node.file));
    const owner = source && this.findNode(source, node);
    if (!owner || !source || !this.checker || node.external) return { edges: [], unresolved: [] };
    const edges = new Map<string, Dependency>();
    const unresolved: Unresolved[] = [];
    const add = (expression: ts.Node, kind: EdgeKind, siteNode: ts.Node, resolved?: ts.Symbol) => {
      let symbol = resolved ?? this.checker!.getSymbolAtLocation(expression);
      const site = this.location(source, siteNode);
      if (!symbol) { unresolved.push({ kind, site, expression: expression.getText(source), reason: 'no symbol' }); return; }
      const alias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
      if (alias) symbol = this.checker!.getAliasedSymbol(symbol);
      // `out.push`, `items.sort`: members of built-in types are neither repository code nor a gap in the analysis.
      if (symbol.declarations?.length && symbol.declarations.every(each => this.isLibrary(each.getSourceFile()))) return;
      const targetDeclaration = symbol.declarations?.map(declaration).find(Boolean);
      if (!targetDeclaration) { unresolved.push({ kind, site, expression: expression.getText(source), reason: 'no source declaration' }); return; }
      const targetSource = targetDeclaration.getSourceFile();
      if (targetSource.isDeclarationFile && !targetSource.fileName.includes('node_modules')) return;
      // TypeScript's own lib.*.d.ts (Promise, Response, parseInt, ...) and Node's built-in typings
      // (crypto, fs, ...) never tell an agent anything about the repository.
      if (this.isLibrary(targetSource)) return;
      const target = this.toCodeNode(targetDeclaration, qualifiedName(targetDeclaration, symbol.getName()));
      if (target.id === node.id || (target.external && !targetSource.fileName.includes('node_modules'))) return;
      const edgeKind = kind === 'call' && ts.isCallExpression(siteNode) && ts.isPropertyAccessExpression(siteNode.expression) ? 'method' : kind;
      edges.set(target.id, { kind: alias && kind === 'call' ? 'import' : edgeKind, target, site });
    };
    const visit = (current: ts.Node) => {
      if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
        const expression = current.expression;
        add(ts.isPropertyAccessExpression(expression) ? expression.name : expression, ts.isNewExpression(current) ? 'new' : 'call', current);
      } else if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) add(current.tagName, 'jsx', current);
      else if (ts.isTypeReferenceNode(current)) add(ts.isQualifiedName(current.typeName) ? current.typeName.right : current.typeName, 'type', current);
      // `class A extends B implements C`: the base class and the implemented interfaces are its contract.
      else if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent)) {
        add(ts.isPropertyAccessExpression(current.expression) ? current.expression.name : current.expression, 'type', current);
      } else if (values && ts.isIdentifier(current) && isModuleConstant(current)) add(current, 'value', current);
      // `Mode.Throw`: the enum the lead branches on is part of its contract.
      else if (values && ts.isPropertyAccessExpression(current) && isEnumMember(this.checker!.getSymbolAtLocation(current.name))) {
        add(ts.isPropertyAccessExpression(current.expression) ? current.expression.name : current.expression, 'value', current);
      }
      // The instance state a method works on: `this.bodyCache`, or `const { bodyCache } = this`.
      else if (values && ts.isPropertyAccessExpression(current) && current.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const symbol = this.checker!.getSymbolAtLocation(current.name);
        if (isStateField(symbol)) add(current.name, 'value', current, symbol);
      } else if (values && ts.isVariableDeclaration(current) && ts.isObjectBindingPattern(current.name) && current.initializer?.kind === ts.SyntaxKind.ThisKeyword) {
        const type = this.checker!.getTypeAtLocation(current.initializer);
        for (const element of current.name.elements) {
          const key = element.propertyName ?? element.name;
          const symbol = ts.isIdentifier(key) ? type.getProperty(key.text) : undefined;
          if (isStateField(symbol)) add(key, 'value', element, symbol);
        }
      }
      ts.forEachChild(current, visit);
    };
    // A data field of a class; function-valued properties are reached through their calls instead.
    const isStateField = (symbol: ts.Symbol | undefined): symbol is ts.Symbol => {
      const declaration = symbol?.valueDeclaration;
      return declaration !== undefined && ts.isPropertyDeclaration(declaration)
        && !(declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)));
    };
    // A reference to a top-level `const` whose initializer is data rather than a function (configuration
    // objects, lookup tables, defaults). Function-valued constants are already reached through calls.
    const isModuleConstant = (identifier: ts.Identifier): boolean => {
      if (ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier) return false;
      let symbol = this.checker!.getSymbolAtLocation(identifier);
      if (!symbol) return false;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker!.getAliasedSymbol(symbol);
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.name === identifier || !declaration.initializer) return false;
      const statement = declaration.parent.parent;
      if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return false;
      if (!(declaration.parent.flags & ts.NodeFlags.Const)) return false;
      const initializer = declaration.initializer;
      return !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer));
    };
    ts.forEachChild(owner, visit);
    return { edges: [...edges.values()], unresolved };
  }

  /**
   * Who uses this declaration. Calls and constructions come from TypeScript's call hierarchy, which resolves
   * import aliases, private `#members`, default exports and functions held in variables. Each call site is
   * then attributed to the smallest enclosing function (an `it(...)` callback rather than the whole test
   * module, which is how the call hierarchy groups anonymous callbacks). Type-level declarations are used
   * through annotations rather than calls, so their users come from reference search.
   */
  private scanReverseDependencies(node: CodeNode): DependencyScan {
    if (!this.program || !this.service) return { edges: [], unresolved: [] };
    const program = this.program;
    const service = this.service;
    const entrySource = program.getSourceFile(path.resolve(this.root, node.file));
    const entryDeclaration = entrySource && this.findNode(entrySource, node);
    const entryName = entryDeclaration && declarationName(entryDeclaration);
    if (!entrySource || !entryDeclaration || !entryName) return { edges: [], unresolved: [] };
    const edges = new Map<string, Dependency>();
    const record = (source: ts.SourceFile, site: ts.Node) => {
      const owner = callerOwner(site) ?? this.componentOwner(source, site);
      if (!owner) return;
      const caller = this.toCodeNode(owner.node, owner.name);
      if (caller.id === node.id || edges.has(caller.id)) return;
      edges.set(caller.id, { kind: isTestFile(caller.file) ? 'test' : 'caller', target: caller, site: this.location(source, site) });
    };
    const projectSource = (fileName: string) => {
      if (!this.insideRoot(fileName)) return undefined;
      const source = program.getSourceFile(fileName);
      return source && !source.isDeclarationFile ? source : undefined;
    };

    const prepared = service.prepareCallHierarchy(entrySource.fileName, entryName.getStart(entrySource));
    const hierarchyItems = prepared ? ([] as ts.CallHierarchyItem[]).concat(prepared) : [];
    for (const item of hierarchyItems) {
      for (const call of service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
        const source = projectSource(call.from.file);
        if (!source) continue;
        for (const span of call.fromSpans) {
          const site = nodeAt(source, span.start);
          if (site) record(source, site);
        }
      }
    }

    // CommonJS: after `module.exports = { f }`, TypeScript resolves `require` uses only from the use site;
    // neither the call hierarchy nor reference search reaches them from the declaration. For JavaScript
    // entries, same-named identifiers elsewhere are kept when the checker resolves them back to the entry.
    const target = this.checker?.getSymbolAtLocation(entryName);
    if (target && /\.[cm]?jsx?$/i.test(entrySource.fileName)) {
      const name = entryName.getText(entrySource);
      // Names it is exported under: `{ g: f }` and `exports.g = f` rename it.
      const names = new Set([name]);
      const collect = (current: ts.Node) => {
        if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.initializer) && current.initializer.text === name) names.add(current.name.getText(entrySource));
        else if (ts.isBinaryExpression(current) && ts.isPropertyAccessExpression(current.left) && ts.isIdentifier(current.right) && current.right.text === name) names.add(current.left.name.text);
        ts.forEachChild(current, collect);
      };
      collect(entrySource);
      for (const candidate of program.getSourceFiles()) {
        const source = candidate !== entrySource && [...names].some(each => candidate.text.includes(each)) ? projectSource(candidate.fileName) : undefined;
        if (!source) continue;
        const visit = (current: ts.Node) => {
          if (ts.isIdentifier(current) && names.has(current.text) && this.resolvesTo(current, target)) record(source, current);
          ts.forEachChild(current, visit);
        };
        visit(source);
      }
    }

    const typeLike = ts.isInterfaceDeclaration(entryDeclaration) || ts.isTypeAliasDeclaration(entryDeclaration)
      || ts.isEnumDeclaration(entryDeclaration) || ts.isClassDeclaration(entryDeclaration);
    // The call hierarchy does not cover every function form: a class property holding an arrow function
    // (`#cachedBody = (key) => …`) prepares no item. Reference search finds those call sites instead.
    if (typeLike || !hierarchyItems.length) {
      for (const group of service.findReferences(entrySource.fileName, entryName.getStart(entrySource)) ?? []) {
        for (const reference of group.references) {
          if (reference.isDefinition) continue;
          const source = projectSource(reference.fileName);
          const site = source && nodeAt(source, reference.textSpan.start);
          // Imports are not uses; calls and `new` were attributed above.
          if (!source || !site || ts.findAncestor(site, ts.isImportDeclaration)) continue;
          record(source, site);
        }
      }
    }
    return { edges: [...edges.values()], unresolved: [] };
  }

  /**
   * What the lead's callers pass into its parameters: the function a callback argument names, or the function
   * whose result a variable holds (`const dist = distanceField(grid); lootCandidates(…, dist)` → distanceField).
   * A parameter is a dependency the lead's own body cannot show, so neither forward nor reverse edges reach it.
   * Test call sites are skipped (they pass fixtures), and values that arrive through the caller's own
   * parameters are not followed further up.
   */
  private scanArgumentSources(node: CodeNode): DependencyScan {
    if (!this.program || !this.service || !this.checker) return { edges: [], unresolved: [] };
    const program = this.program;
    const service = this.service;
    const checker = this.checker;
    const entrySource = program.getSourceFile(path.resolve(this.root, node.file));
    const entryDeclaration = entrySource && this.findNode(entrySource, node);
    const entryName = entryDeclaration && declarationName(entryDeclaration);
    const fn = entryDeclaration && functionOf(entryDeclaration);
    if (!entrySource || !entryName || !fn?.parameters.length) return { edges: [], unresolved: [] };
    const parameters = fn.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(entrySource));
    const rest = fn.parameters.at(-1)?.dotDotDotToken !== undefined;

    const sites: Array<{ source: ts.SourceFile; site: ts.Node }> = [];
    const projectSource = (fileName: string) => {
      const source = this.insideRoot(fileName) && !isTestFile(path.relative(this.root, fileName).replaceAll('\\', '/')) ? program.getSourceFile(fileName) : undefined;
      return source && !source.isDeclarationFile ? source : undefined;
    };
    const prepared = service.prepareCallHierarchy(entrySource.fileName, entryName.getStart(entrySource));
    const hierarchyItems = prepared ? ([] as ts.CallHierarchyItem[]).concat(prepared) : [];
    for (const item of hierarchyItems) {
      for (const call of service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
        const source = projectSource(call.from.file);
        for (const span of source ? call.fromSpans : []) {
          const site = nodeAt(source!, span.start);
          if (site) sites.push({ source: source!, site });
        }
      }
    }
    // Functions held in class properties prepare no call-hierarchy item (see scanReverseDependencies).
    if (!hierarchyItems.length) {
      for (const group of service.findReferences(entrySource.fileName, entryName.getStart(entrySource)) ?? []) {
        for (const reference of group.references) {
          const source = reference.isDefinition ? undefined : projectSource(reference.fileName);
          const site = source && nodeAt(source, reference.textSpan.start);
          if (source && site) sites.push({ source, site });
        }
      }
    }

    const edges = new Map<string, Dependency>();
    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
      return current;
    };
    const fromSymbol = (raw: ts.Symbol | undefined, hops: number): ts.Node[] => {
      const symbol = raw && raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
      const target = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (!target || ts.isParameter(target) || ts.isBindingElement(target)) return [];
      if (ts.isVariableDeclaration(target)) {
        const initializer = target.initializer;
        const statement = target.parent.parent;
        const moduleLevel = ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && moduleLevel) return [statement];
        if (initializer && hops < 2) {
          const traced = fromExpression(initializer, hops + 1);
          if (traced.length) return traced;
        }
        return moduleLevel && target.parent.flags & ts.NodeFlags.Const ? [statement] : [];
      }
      const unit = declaration(target);
      return unit ? [unit] : [];
    };
    const fromExpression = (raw: ts.Expression, hops: number): ts.Node[] => {
      const expression = unwrap(raw);
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return [expression];
      if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
        const callee = unwrap(expression.expression);
        return fromSymbol(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee), 2);
      }
      if (ts.isIdentifier(expression)) return fromSymbol(checker.getSymbolAtLocation(expression), hops);
      if (ts.isPropertyAccessExpression(expression)) return fromSymbol(checker.getSymbolAtLocation(expression.name), hops);
      if (hops >= 2) return [];
      if (ts.isConditionalExpression(expression)) return [...fromExpression(expression.whenTrue, hops + 1), ...fromExpression(expression.whenFalse, hops + 1)];
      if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(expression.operatorToken.kind))
        return [...fromExpression(expression.left, hops + 1), ...fromExpression(expression.right, hops + 1)];
      if (ts.isObjectLiteralExpression(expression)) return expression.properties.flatMap(property =>
        ts.isPropertyAssignment(property) ? fromExpression(property.initializer, hops + 1)
          : ts.isShorthandPropertyAssignment(property) ? fromSymbol(checker.getShorthandAssignmentValueSymbol(property), hops + 1) : []);
      return [];
    };

    for (const { source, site } of sites) {
      if (edges.size >= maxArgumentSources) break;
      // From the callee name up to the call: `f(…)`, `obj.f(…)`, `this.#f(…)`, `new F(…)`.
      let callee: ts.Node = site;
      while (callee.parent && ((ts.isPropertyAccessExpression(callee.parent) && callee.parent.name === callee)
        || ts.isParenthesizedExpression(callee.parent) || ts.isNonNullExpression(callee.parent))) callee = callee.parent;
      const call = callee.parent;
      if (!call || !(ts.isCallExpression(call) || ts.isNewExpression(call)) || call.expression !== callee) continue;
      for (const [index, argument] of (call.arguments ?? []).entries()) {
        const parameter = parameters[Math.min(index, parameters.length - 1)];
        if (index >= parameters.length && !rest) break;
        for (const found of fromExpression(argument, 0)) {
          const foundSource = found.getSourceFile();
          if (this.isLibrary(foundSource) || foundSource.isDeclarationFile || !this.insideRoot(foundSource.fileName)) continue;
          const name = ts.isArrowFunction(found) || ts.isFunctionExpression(found) ? callbackName(found) : qualifiedName(found, '<value>');
          const target = this.toCodeNode(found, name);
          if (target.id === node.id || edges.has(target.id) || edges.size >= maxArgumentSources) continue;
          edges.set(target.id, { kind: 'argument', target, site: this.location(source, argument), parameter });
        }
      }
    }
    return { edges: [...edges.values()], unresolved: [] };
  }

  /**
   * Functions that read what the lead reads: an enum member (`Mode.Throw`), a module-level constant, or a key of
   * a module-level configuration object (`CONFIG.grenade.range`). Data flow of this kind (an action mask that
   * allows `Mode.Throw`, a cooldown both a planner and an executor check) has no call edge between the two.
   * Widely read values (more than `maxSharedReferences` uses) are skipped as hubs; test files are skipped.
   */
  private scanSharedReaders(node: CodeNode): DependencyScan {
    if (!this.program || !this.service || !this.checker) return { edges: [], unresolved: [] };
    const program = this.program;
    const service = this.service;
    const checker = this.checker;
    const source = program.getSourceFile(path.resolve(this.root, node.file));
    const owner = source && this.findNode(source, node);
    if (!source || !owner) return { edges: [], unresolved: [] };

    const read = new Map<ts.Symbol, { label: string; name: ts.Node }>();
    const record = (raw: ts.Symbol | undefined, label: string) => {
      const symbol = raw && raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
      const declaration = declarationOf(symbol);
      if (!symbol || !declaration || read.has(symbol) || read.size >= maxSharedSymbols) return;
      const name = (declaration as ts.NamedDeclaration).name;
      const declarationSource = declaration.getSourceFile();
      if (!name || declarationSource.isDeclarationFile || this.isLibrary(declarationSource) || !this.insideRoot(declarationSource.fileName)) return;
      if (ts.isEnumMember(declaration) || moduleDataConstant(declaration) || configurationKey(declaration)) read.set(symbol, { label: clip(label, 48), name });
    };
    const visit = (current: ts.Node) => {
      if (ts.isPropertyAccessExpression(current)) {
        const symbol = checker.getSymbolAtLocation(current.name);
        const declaration = declarationOf(symbol);
        if (declaration && (ts.isEnumMember(declaration) || configurationKey(declaration))) {
          record(symbol, current.getText(source));
          return;
        }
      } else if (ts.isIdentifier(current) && !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current)
        && !((current.parent as ts.NamedDeclaration).name === current)) {
        record(checker.getSymbolAtLocation(current), current.text);
      }
      ts.forEachChild(current, visit);
    };
    ts.forEachChild(owner, visit);

    const edges = new Map<string, Dependency>();
    for (const [, { label, name }] of read) {
      if (edges.size >= maxSharedEdges) break;
      const declarationSource = name.getSourceFile();
      const references = (service.findReferences(declarationSource.fileName, name.getStart(declarationSource)) ?? [])
        .flatMap(group => group.references).filter(reference => !reference.isDefinition);
      if (references.length > maxSharedReferences) continue;
      // Readers in other files first: those are the connections a look at the lead's own file does not show.
      references.sort((a, b) => Number(a.fileName === source.fileName) - Number(b.fileName === source.fileName) || a.fileName.localeCompare(b.fileName) || a.textSpan.start - b.textSpan.start);
      let perSymbol = 0;
      for (const reference of references) {
        if (perSymbol >= maxSharedPerSymbol || edges.size >= maxSharedEdges) break;
        if (!this.insideRoot(reference.fileName) || isTestFile(path.relative(this.root, reference.fileName).replaceAll('\\', '/'))) continue;
        const referenceSource = program.getSourceFile(reference.fileName);
        const site = referenceSource && !referenceSource.isDeclarationFile ? nodeAt(referenceSource, reference.textSpan.start) : undefined;
        if (!referenceSource || !site || ts.findAncestor(site, ts.isImportDeclaration)) continue;
        if (referenceSource === source && site.getStart(source) >= owner.getStart(source) && site.getEnd() <= owner.getEnd()) continue;
        const reader = callerOwner(site) ?? this.componentOwner(referenceSource, site);
        if (!reader) continue;
        const target = this.toCodeNode(reader.node, reader.name);
        if (target.id === node.id || edges.has(target.id)) continue;
        edges.set(target.id, { kind: 'shared', target, site: this.location(referenceSource, site), symbol: label });
        perSymbol++;
      }
    }
    return { edges: [...edges.values()], unresolved: [] };
  }

  private isLibrary(source: ts.SourceFile): boolean {
    return this.program!.isSourceFileDefaultLibrary(source) || /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(source.fileName);
  }

  /** Top-level `<script setup>` code runs as the component's setup, so its calls belong to the component. */
  private componentOwner(source: ts.SourceFile, site: ts.Node): { node: ts.Node; name: string } | undefined {
    if (!isVueFile(source.fileName)) return undefined;
    const text = ts.sys.readFile(source.fileName);
    const setup = text === undefined ? undefined : vueScript(text, source.fileName).setup;
    const position = site.getStart(source);
    if (!setup || position < setup.start || position >= setup.end) return undefined;
    return { node: source, name: `${path.basename(source.fileName)} <script setup>` };
  }

  /** Follows import aliases and CommonJS export objects (`{ f }`, `{ g: f }`, `exports.g = f`) to the exported symbol. */
  private resolvesTo(identifier: ts.Identifier, target: ts.Symbol): boolean {
    const checker = this.checker!;
    let symbol = checker.getSymbolAtLocation(identifier);
    for (let hop = 0; symbol && hop < 5; hop++) {
      if (symbol === target) return true;
      if (symbol.flags & ts.SymbolFlags.Alias) { symbol = checker.getAliasedSymbol(symbol); continue; }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) return false;
      if (ts.isShorthandPropertyAssignment(declaration)) symbol = checker.getShorthandAssignmentValueSymbol(declaration);
      else if (ts.isPropertyAssignment(declaration) && ts.isIdentifier(declaration.initializer)) symbol = checker.getSymbolAtLocation(declaration.initializer);
      else if (ts.isBinaryExpression(declaration.parent) && declaration.parent.left === (declaration as ts.Node) && ts.isIdentifier(declaration.parent.right)) symbol = checker.getSymbolAtLocation(declaration.parent.right);
      else return false;
    }
    return false;
  }

  supportingContext(node: CodeNode): SupportingContext[] {
    if (!node.external) this.loadProgram(this.safePath(node.file));
    const source = this.program?.getSourceFile(path.resolve(this.root, node.file));
    const owner = source && this.findNode(source, node);
    if (!source || !owner || !this.checker || node.external) return [];

    const ownerStart = owner.getStart(source);
    const ownerEnd = owner.getEnd();
    const results = new Map<string, SupportingContext>();
    const queue: Array<{ root: ts.Node; hop: number }> = [{ root: owner, hop: 0 }];
    const scanned = new Set<string>();

    while (queue.length && results.size < 6) {
      const { root, hop } = queue.shift()!;
      const rootKey = `${root.getStart(source)}:${root.getEnd()}`;
      if (scanned.has(rootKey)) continue;
      scanned.add(rootKey);

      const visit = (current: ts.Node) => {
        if (results.size >= 6) return;
        if (ts.isIdentifier(current)) {
          let symbol = this.checker!.getSymbolAtLocation(current);
          if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = this.checker!.getAliasedSymbol(symbol);
          for (const raw of symbol?.declarations ?? []) {
            let target: ts.Node | undefined;
            let kind: SupportingContext['kind'] | undefined;
            if (ts.isVariableDeclaration(raw)) {
              if (raw.initializer && (ts.isArrowFunction(raw.initializer) || ts.isFunctionExpression(raw.initializer))) continue;
              target = declaration(raw);
              kind = 'value';
            } else if (ts.isInterfaceDeclaration(raw) || ts.isTypeAliasDeclaration(raw) || ts.isEnumDeclaration(raw)) {
              target = raw;
              kind = 'type';
            }
            if (!target || !kind || target.getSourceFile() !== source) continue;
            const start = target.getStart(source);
            const end = target.getEnd();
            if (start >= ownerStart && end <= ownerEnd) continue;
            const id = `${node.file}:${start}:${end}`;
            if (results.has(id)) continue;

            const contextNode = this.toCodeNode(target, symbol?.getName() ?? named(target) ?? '<context>');
            results.set(id, {
              name: contextNode.name,
              file: contextNode.file,
              kind,
              signature: contextNode.signature,
              source: contextNode.source,
            });
            if (hop < 1) queue.push({ root: target, hop: hop + 1 });
            if (results.size >= 6) break;
          }
        }
        ts.forEachChild(current, visit);
      };
      visit(root);
    }

    return [...results.values()];
  }

  private loadProgram(entry: string): void {
    const project = selectProjectFromParsed(this.projectConfigs, entry);
    const configPath = project?.path;
    let files: string[];
    let options: ts.CompilerOptions;
    let projectReferences: readonly ts.ProjectReference[] | undefined;
    let scopeDirectory = '';
    if (project) {
      files = project.parsed.fileNames;
      options = project.parsed.options;
      projectReferences = project.parsed.projectReferences;
    } else {
      if (!this.unconfigured || Date.now() - this.unconfigured.at > unconfiguredListMs) {
        const all: string[] = [];
        collectSources(path.resolve(this.root), all);
        this.unconfigured = { at: Date.now(), files: all };
      }
      const scope = unconfiguredScope(path.resolve(this.root), this.unconfigured.files, path.resolve(entry));
      files = scope.files;
      scopeDirectory = scope.directory;
      options = { allowJs: true, checkJs: false, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, noEmit: true };
    }
    // Configs are parsed once, so a config path identifies its file list; hashing the list itself on every
    // call cost more than the lookup in a repository with thousands of files.
    const key = configPath ? `config:${configPath}` : `unconfigured:${scopeDirectory}:${files.length}:${files[0] ?? ''}:${files.at(-1) ?? ''}`;
    const warm = this.projectKey === key ? this.service : this.services.get(key);
    if (warm) {
      // Most-recently-used order: re-insert on every use.
      this.services.delete(key);
      this.services.set(key, warm);
      this.service = warm;
      this.program = warm.getProgram();
      this.checker = this.program?.getTypeChecker();
      this.projectKey = key;
      return;
    }
    if (this.services.size >= maxWarmProjects) {
      const [coldestKey, coldest] = this.services.entries().next().value!;
      coldest.dispose();
      this.services.delete(coldestKey);
    }
    const hasVue = files.some(isVueFile);
    // Vue components are read through their script blocks (see vue.ts); the compiler accepts the extension.
    if (hasVue) options = { ...options, allowNonTsExtensions: true };
    const moduleHost: ts.ModuleResolutionHost = {
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories, realpath: ts.sys.realpath, useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    };
    // `./Button.vue` or `@/components/Button.vue`: resolved as if `Button.vue.ts` existed, so `paths` aliases
    // and base URLs apply exactly as they do for scripts, then mapped back to the component.
    const vueModuleHost: ts.ModuleResolutionHost = { ...moduleHost, fileExists: file => /\.vue\.ts$/i.test(file) ? ts.sys.fileExists(file.slice(0, -3)) : ts.sys.fileExists(file) };
    const resolutionCache = ts.createModuleResolutionCache(configPath ? path.dirname(configPath) : this.root, name => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(), options);
    const extensionOf = (kind: ts.ScriptKind): ts.Extension =>
      kind === ts.ScriptKind.TSX ? ts.Extension.Tsx : kind === ts.ScriptKind.TS ? ts.Extension.Ts : kind === ts.ScriptKind.JSX ? ts.Extension.Jsx : ts.Extension.Js;
    const vueKind = (file: string): ts.ScriptKind => {
      const text = ts.sys.readFile(file);
      return text === undefined ? ts.ScriptKind.TS : vueScript(text, file).kind;
    };
    const service = ts.createLanguageService({
      getCompilationSettings: () => options,
      getScriptFileNames: () => files,
      getScriptVersion: file => {
        try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '0'; }
      },
      getScriptSnapshot: file => {
        const text = ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(scriptText(file, text));
      },
      getScriptKind: file => isVueFile(file) ? vueKind(file) : ts.ScriptKind.Unknown,
      ...(hasVue ? {
        resolveModuleNameLiterals: (literals: readonly ts.StringLiteralLike[], containingFile: string, redirected: ts.ResolvedProjectReference | undefined, compilerOptions: ts.CompilerOptions, containingSource: ts.SourceFile) =>
          literals.map(literal => {
            const mode = ts.getModeForUsageLocation(containingSource, literal, compilerOptions);
            if (!isVueFile(literal.text)) return ts.resolveModuleName(literal.text, containingFile, compilerOptions, moduleHost, resolutionCache, redirected, mode);
            const resolved = ts.resolveModuleName(literal.text, containingFile, compilerOptions, vueModuleHost, undefined, redirected, mode);
            const fileName = resolved.resolvedModule?.resolvedFileName;
            if (!fileName || !/\.vue\.ts$/i.test(fileName)) return resolved;
            const component = fileName.slice(0, -3);
            return { resolvedModule: { resolvedFileName: component, extension: extensionOf(vueKind(component)), isExternalLibraryImport: false } };
          }),
      } : {}),
      getCurrentDirectory: () => configPath ? path.dirname(configPath) : this.root,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      getProjectReferences: () => projectReferences,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
    });
    this.services.set(key, service);
    this.service = service;
    this.program = this.service.getProgram();
    if (!this.program) throw new Error('TypeScript language service could not create a program');
    this.checker = this.program.getTypeChecker();
    this.projectKey = key;
  }
  private safePath(file: string): string {
    const absolute = path.resolve(this.root, file);
    if (!this.insideRoot(absolute)) throw new UserFacingError('Entry file must be inside project root');
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new UserFacingError(`Entry file does not exist: ${file}`);
    return absolute;
  }
  private insideRoot(file: string): boolean {
    const relative = path.relative(this.root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  private findNode(source: ts.SourceFile, node: CodeNode): ts.Node | undefined {
    const start = Number(node.id.split(':').at(-2));
    const end = Number(node.id.split(':').at(-1));
    let result: ts.Node | undefined;
    const visit = (current: ts.Node) => {
      if (current.getStart(source) === start && current.getEnd() === end) { result = current; return; }
      ts.forEachChild(current, visit);
    };
    visit(source);
    return result;
  }
  private location(source: ts.SourceFile, node: ts.Node): SourceLocation {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return { file: path.relative(this.root, source.fileName).replaceAll('\\', '/'), line, text: source.text.split(/\r?\n/)[line - 1]?.trim().slice(0, 300) };
  }
  private toCodeNode(node: ts.Node, name: string): CodeNode {
    const source = node.getSourceFile();
    const file = path.relative(this.root, source.fileName).replaceAll('\\', '/');
    const start = node.getStart(source);
    const end = node.getEnd();
    return { id: `${file}:${start}:${end}`, name, file,
      startLine: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(end).line + 1,
      source: source.text.slice(start, end), signature: signature(node, source), external: !this.insideRoot(source.fileName) || source.isDeclarationFile,
      ...(ts.isClassDeclaration(node) ? { outline: true } : {}) };
  }
}
