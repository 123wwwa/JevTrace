import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import type { CodeNode, Dependency, DependencyScan, EdgeKind, EntryInput, LanguageAdapter, SourceLocation, SupportingContext, Unresolved } from './types.js';

const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
function collectSources(dir: string, files: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (files.length >= 3000) throw new Error('Source file limit exceeded; add a tsconfig.json');
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) collectSources(full, files);
    else if (entry.isFile() && extensions.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) files.push(full);
  }
}
function declaration(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) || ts.isPropertyDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node)) return node.parent.parent;
  return undefined;
}
function named(node: ts.Node): string | undefined { return (node as ts.NamedDeclaration).name?.getText(); }
function callerOwner(node: ts.Node): { node: ts.Node; name: string } | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isGetAccessor(current)
        || ts.isSetAccessor(current) || ts.isConstructorDeclaration(current)) {
      return { node: current, name: named(current) ?? '<caller>' };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) return { node: parent.parent.parent, name: parent.name.getText() };
      if (ts.isPropertyDeclaration(parent)) return { node: parent, name: named(parent) ?? '<caller>' };
      return { node: current, name: '<caller>' };
    }
    current = current.parent;
  }
  return undefined;
}
function signature(node: ts.Node, source: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
    return source.text.slice(node.getStart(source), node.body ? node.body.getStart(source) : node.getEnd()).trim();
  if (ts.isClassDeclaration(node)) return source.text.slice(node.getStart(source), node.members.pos).trim() + ' { … }';
  if (ts.isVariableStatement(node)) return source.text.slice(node.getStart(source), Math.min(node.getEnd(), node.getStart(source) + 240)).split('\n')[0];
  return source.text.slice(node.getStart(source), Math.min(node.getEnd(), node.getStart(source) + 500));
}

export class TypeScriptAdapter implements LanguageAdapter {
  readonly language = 'javascript-typescript';
  private program?: ts.Program;
  private checker?: ts.TypeChecker;
  private projectKey?: string;
  private service?: ts.LanguageService;
  constructor(readonly root: string) {}

  findEntry(input: EntryInput): CodeNode {
    const absolute = this.safePath(input.file);
    this.loadProgram(absolute);
    const source = this.program!.getSourceFile(absolute);
    if (!source) throw new Error(`File is not in its TypeScript project: ${input.file}`);
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
    if (!matches.length) throw new Error(`No declaration found at ${input.file}:${input.line ?? input.symbol}`);
    matches.sort((a, b) => (a.node.getEnd() - a.node.getStart(source)) - (b.node.getEnd() - b.node.getStart(source)));
    if (input.line === undefined && matches.length > 1) throw new Error(`Symbol ${input.symbol} is ambiguous; supply a line`);
    return this.toCodeNode(matches[0].node, matches[0].name);
  }

  dependencies(node: CodeNode): DependencyScan {
    const source = this.program?.getSourceFile(path.resolve(this.root, node.file));
    const owner = source && this.findNode(source, node);
    if (!owner || !source || !this.checker || node.external) return { edges: [], unresolved: [] };
    const edges = new Map<string, Dependency>();
    const unresolved: Unresolved[] = [];
    const add = (expression: ts.Node, kind: EdgeKind, siteNode: ts.Node) => {
      let symbol = this.checker!.getSymbolAtLocation(expression);
      const site = this.location(source, siteNode);
      if (!symbol) { unresolved.push({ kind, site, expression: expression.getText(source), reason: 'no symbol' }); return; }
      const alias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
      if (alias) symbol = this.checker!.getAliasedSymbol(symbol);
      const targetDeclaration = symbol.declarations?.map(declaration).find(Boolean);
      if (!targetDeclaration) { unresolved.push({ kind, site, expression: expression.getText(source), reason: 'no source declaration' }); return; }
      const targetSource = targetDeclaration.getSourceFile();
      if (targetSource.isDeclarationFile && !targetSource.fileName.includes('node_modules')) return;
      const target = this.toCodeNode(targetDeclaration, symbol.getName());
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
      ts.forEachChild(current, visit);
    };
    ts.forEachChild(owner, visit);
    return { edges: [...edges.values()], unresolved };
  }

  reverseDependencies(node: CodeNode): DependencyScan {
    if (!this.program || !this.service) return { edges: [], unresolved: [] };
    const entrySource = this.program.getSourceFile(path.resolve(this.root, node.file));
    const entryDeclaration = entrySource && this.findNode(entrySource, node);
    const entryName = entryDeclaration && (entryDeclaration as ts.NamedDeclaration).name;
    if (!entrySource || !entryName) return { edges: [], unresolved: [] };
    const edges = new Map<string, Dependency>();
    const pending: Array<{ fileName: string; position: number }> = [{ fileName: entrySource.fileName, position: entryName.getStart(entrySource) }];
    const searched = new Set<string>();

    while (pending.length) {
      const current = pending.shift()!;
      const key = `${current.fileName}:${current.position}`;
      if (searched.has(key)) continue;
      searched.add(key);
      const references = this.service.findReferences(current.fileName, current.position) ?? [];
      for (const group of references) for (const ref of group.references) {
        if (!this.insideRoot(ref.fileName)) continue;
        const source = this.program.getSourceFile(ref.fileName);
        if (!source || source.isDeclarationFile) continue;
        let siteNode: ts.Node | undefined;
        const find = (candidate: ts.Node) => {
          if (ref.textSpan.start < candidate.getStart(source) || ref.textSpan.start >= candidate.getEnd()) return;
          siteNode = candidate;
          ts.forEachChild(candidate, find);
        };
        find(source);
        if (!siteNode) continue;

        let imported: ts.Node | undefined = siteNode;
        while (imported && !ts.isImportSpecifier(imported) && !ts.isImportClause(imported) && imported !== source) imported = imported.parent;
        if (imported && imported !== source) {
          let localName: ts.Identifier | undefined;
          if (ts.isImportSpecifier(imported)) localName = imported.name;
          else if (ts.isImportClause(imported)) localName = imported.name;
          if (localName) pending.push({ fileName: source.fileName, position: localName.getStart(source) });
          continue;
        }

        if (ref.isDefinition) continue;
        let call = siteNode;
        while (call && !ts.isCallExpression(call) && !ts.isNewExpression(call)) call = call.parent;
        if (!call || ref.textSpan.start < call.expression.getStart(source) || ref.textSpan.start >= call.expression.getEnd()) continue;
        const owner = callerOwner(call.parent);
        if (!owner) continue;
        const caller = this.toCodeNode(owner.node, owner.name);
        const isTest = /(?:^|[/.])(?:__tests__|test|tests|spec)(?:[/.]|$)/i.test(caller.file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(caller.file);
        edges.set(caller.id, { kind: isTest ? 'test' : 'caller', target: caller, site: this.location(source, call) });
      }
    }

    // LanguageService references can stop at an import alias definition. Recover cross-file
    // callers with the checker, but only in files that actually import the target symbol.
    const checker = this.checker;
    if (checker) {
      const resolvedNodeId = (identifier: ts.Identifier): string | undefined => {
        let symbol = checker.getSymbolAtLocation(identifier);
        if (!symbol) return undefined;
        if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const targetDeclaration = symbol.declarations?.map(declaration).find(Boolean);
        if (!targetDeclaration) return undefined;
        return this.toCodeNode(targetDeclaration, symbol.getName()).id;
      };
      for (const source of this.program.getSourceFiles()) {
        if (source === entrySource || source.isDeclarationFile || !this.insideRoot(source.fileName)) continue;
        let importsTarget = false;
        for (const statement of source.statements) {
          if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
          const clause = statement.importClause;
          if (clause.name) {
            const resolved = resolvedNodeId(clause.name);
            if (resolved === node.id) importsTarget = true;
          }
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const specifier of clause.namedBindings.elements) {
              const resolved = resolvedNodeId(specifier.name);
              if (resolved === node.id) importsTarget = true;
            }
          }
          if (importsTarget) break;
        }
        if (!importsTarget) continue;

        const visitCalls = (current: ts.Node) => {
          if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
            const expression = current.expression;
            const identifier = ts.isIdentifier(expression)
              ? expression
              : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)
                ? expression.name
                : undefined;
            if (identifier) {
              const resolved = resolvedNodeId(identifier);
              if (resolved !== node.id) { ts.forEachChild(current, visitCalls); return; }
              const owner = callerOwner(current.parent);
              if (owner) {
                const caller = this.toCodeNode(owner.node, owner.name);
                const isTest = /(?:^|[/.])(?:__tests__|test|tests|spec)(?:[/.]|$)/i.test(caller.file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(caller.file);
                edges.set(caller.id, { kind: isTest ? 'test' : 'caller', target: caller, site: this.location(source, current) });
              }
            }
          }
          ts.forEachChild(current, visitCalls);
        };
        visitCalls(source);
      }
    }
    return { edges: [...edges.values()], unresolved: [] };
  }

  supportingContext(node: CodeNode): SupportingContext[] {
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
    const found = ts.findConfigFile(path.dirname(entry), ts.sys.fileExists, 'tsconfig.json');
    const configPath = found && this.insideRoot(found) ? found : undefined;
    let files: string[];
    let options: ts.CompilerOptions;
    let projectReferences: readonly ts.ProjectReference[] | undefined;
    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
      if (parsed.errors.length) throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, '\n'));
      files = parsed.fileNames;
      options = parsed.options;
      projectReferences = parsed.projectReferences;
    } else {
      files = [];
      collectSources(this.root, files);
      options = { allowJs: true, checkJs: false, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, noEmit: true };
    }
    const key = JSON.stringify([configPath ?? this.root, files, options, projectReferences]);
    if (this.projectKey === key) {
      this.program = this.service?.getProgram();
      this.checker = this.program?.getTypeChecker();
      return;
    }
    this.service?.dispose();
    this.service = ts.createLanguageService({
      getCompilationSettings: () => options,
      getScriptFileNames: () => files,
      getScriptVersion: file => {
        try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '0'; }
      },
      getScriptSnapshot: file => {
        const text = ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
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
    this.program = this.service.getProgram();
    if (!this.program) throw new Error('TypeScript language service could not create a program');
    this.checker = this.program.getTypeChecker();
    this.projectKey = key;
  }
  private safePath(file: string): string {
    const absolute = path.resolve(this.root, file);
    if (!this.insideRoot(absolute)) throw new Error('Entry file must be inside project root');
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
      source: source.text.slice(start, end), signature: signature(node, source), external: !this.insideRoot(source.fileName) || source.isDeclarationFile };
  }
}
