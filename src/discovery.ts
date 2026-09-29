import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import type { CodeNode, JudgeCallStats, Judgment, LanguageAdapter, RelevanceJudge } from './types.js';
import { parseProjectConfigs } from './project-config.js';

const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo']);
const sourceFile = /\.[cm]?[jt]sx?$/;
const declarationFile = /\.d\.[cm]?ts$/;
const stopWords = new Set('a an the is are to of for in on and or how change fix add implement with when should from'.split(' '));
const tokenize = (text: string): string[] =>
  text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const bm25 = (tf: number, length: number, avgLength: number, idf: number, k1 = 1.2, b = 0.75): number => {
  if (!tf) return 0;
  const norm = tf + k1 * (1 - b + b * (length / Math.max(avgLength, 1)));
  return idf * ((tf * (k1 + 1)) / norm);
};
const count = (values: string[], term: string): number =>
  values.reduce((sum, value) => sum + Number(value === term), 0);
const unique = <T>(values: T[]): T[] => [...new Set(values)];

interface SearchFields {
  name: string[];
  path: string[];
  signature: string[];
  identifiers: string[];
  literals: string[];
}

type ScanResult = { nodes: CodeNode[]; scannedFiles: number; warnings: string[] };
/** A directory scope is split into child scopes once its subtree holds more files than this. */
const maxScopeFiles = 64;

interface RankedNode {
  node: CodeNode;
  retrievalScore: number;
  bm25Score: number;
  exactScore: number;
  pathScore: number;
  evidence: string[];
}

export interface DiscoveryOptions {
  maxCandidates?: number;
  maxLeads?: number;
  maxFiles?: number;
  maxJevFiles?: number;
  maxRelevantDirectories?: number;
  maxRelevantFiles?: number;
  minLeadScore?: number;
  minFileScore?: number;
  includeLexicalHints?: boolean;
  /** Files of the strongest lexical matches that are always judged at file level (default 4, 0 disables). */
  lexicalRescueFiles?: number;
  signal?: AbortSignal;
}

export interface EntryLead {
  file: string;
  line: number;
  endLine: number;
  name: string;
  signature: string;
  retrievalScore: number;
  lexicalScore: number;
  bm25Score?: number;
  exactScore?: number;
  pathScore?: number;
  score?: number;
  evidence: string[];
  /** Interface, type alias, enum or member-less class; such leads only fill slots callables leave open. */
  typeLevel?: boolean;
}

export interface DirectoryLead {
  directory: string;
  score: number;
}

export interface FileLead {
  file: string;
  score: number;
  symbols: string[];
}

export interface DiscoveryResult {
  task: string;
  mode: 'parallel-jev' | 'lexical';
  status: 'complete' | 'incomplete' | 'no-match';
  lexicalCandidates: EntryLead[];
  localCandidates: EntryLead[];
  directoryLeads: DirectoryLead[];
  fileLeads: FileLead[];
  /** Files added to file-level judging by lexical rescue after directory selection and the file cap. */
  rescuedFiles: string[];
  leads: EntryLead[];
  semanticLeads: EntryLead[];
  selected?: EntryLead;
  scannedFiles: number;
  declarations: number;
  judgedCandidates: number;
  latencyMs: number;
  judgeStats: JudgeCallStats;
  directoryJudgeStats: JudgeCallStats;
  fileJudgeStats: JudgeCallStats;
  symbolJudgeStats: JudgeCallStats;
  stageLatencyMs: { directory: number; file: number; symbol: number };
  warnings: string[];
}

function buildTree(files: string[]): string {
  type Tree = Map<string, Tree>;
  const root: Tree = new Map();
  for (const file of [...files].sort()) {
    let current = root;
    for (const part of file.split('/')) {
      if (!current.has(part)) current.set(part, new Map());
      current = current.get(part)!;
    }
  }
  const lines: string[] = [];
  const visit = (tree: Tree, depth: number) => {
    for (const [name, child] of [...tree.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${'  '.repeat(depth)}${name}`);
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return lines.join('\n');
}

/** Lightweight compiler AST inventory. Type checking is deferred until graph resolution. */
export class RepositoryIndex {
  private cache = new Map<string, { version: string; nodes: CodeNode[]; fields: Map<string, SearchFields> }>();
  constructor(readonly root: string) {}

  scan(maxFiles: number, signal?: AbortSignal): { nodes: CodeNode[]; scannedFiles: number; warnings: string[] } {
    const nodes: CodeNode[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const root = path.resolve(this.root);
    const projectInventory = parseProjectConfigs(root);
    warnings.push(...projectInventory.warnings);
    const configuredFiles = new Set(projectInventory.projects.flatMap(project => [...project.files]));
    const hasConfiguredProjects = projectInventory.projects.length > 0;

    let scannedFiles = 0;
    const walk = (directory: string): void => {
      signal?.throwIfAborted();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        if (scannedFiles >= maxFiles) {
          warnings.push(`Discovery file limit reached (${maxFiles})`);
          return;
        }
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.')) {
          walk(full);
        } else if (entry.isFile() && sourceFile.test(entry.name) && !declarationFile.test(entry.name)) {
          scannedFiles++;
          if (hasConfiguredProjects && !configuredFiles.has(path.resolve(full))) continue;
          const stat = fs.statSync(full, { bigint: true });
          if (stat.size > 1024n * 1024n) {
            warnings.push(`Skipped source larger than 1 MiB: ${path.relative(this.root, full)}`);
            continue;
          }
          seen.add(full);
          // Same version key as the TypeScript adapter: unchanged files are neither re-read nor re-parsed.
          const version = `${stat.mtimeNs}:${stat.size}`;
          let cached = this.cache.get(full);
          if (!cached || cached.version !== version) {
            const text = fs.readFileSync(full, 'utf8');
            const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
            const file = path.relative(this.root, full).replaceAll('\\', '/');
            const declarations: CodeNode[] = [];
            const fields = new Map<string, SearchFields>();
            const visit = (node: ts.Node, parents: string[]) => {
              const nameNode = (node as ts.NamedDeclaration).name;
              const ownName = nameNode?.getText(source);
              const isContainer = ts.isClassDeclaration(node) || ts.isModuleDeclaration(node);
              const isCallable = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
                || ts.isGetAccessor(node) || ts.isSetAccessor(node);
              // Only index declarations the compiler adapter can resolve again: variable statements must be top-level.
              const isValue = ((ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) && node.parent.parent.parent === source)
                || ts.isPropertyDeclaration(node))
                && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
              // Type-level declarations are leads too; classes only when they have no indexed members of their own.
              const isTypeLike = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
                || (ts.isClassDeclaration(node) && !node.members.some(member => ts.isMethodDeclaration(member)
                  || ts.isGetAccessor(member) || ts.isSetAccessor(member)
                  || (ts.isPropertyDeclaration(member) && member.initializer !== undefined
                    && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)))));
              if (ownName && (isCallable || isValue || isTypeLike)) {
                const owner = ts.isVariableDeclaration(node) ? node.parent.parent : node;
                const start = owner.getStart(source);
                const end = owner.getEnd();
                const body = isCallable ? (node as ts.FunctionDeclaration).body : isValue ? (node as ts.VariableDeclaration).initializer : undefined;
                const id = `${file}:${start}:${end}`;
                const name = [...parents, ownName].join('.');
                const signature = text.slice(start, body?.getStart(source) ?? Math.min(end, start + 300)).trim();
                const identifierTokens: string[] = [];
                const literalTokens: string[] = [];
                const collect = (current: ts.Node) => {
                  if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) {
                    identifierTokens.push(...tokenize(current.getText(source)));
                  } else if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current)) {
                    literalTokens.push(...tokenize(current.getText(source)));
                  }
                  ts.forEachChild(current, collect);
                };
                collect(owner);
                declarations.push({
                  id,
                  name,
                  file,
                  startLine: source.getLineAndCharacterOfPosition(start).line + 1,
                  endLine: source.getLineAndCharacterOfPosition(end).line + 1,
                  signature,
                  source: text.slice(start, end),
                });
                // Type-level declarations are semantic leads only: their property names and doc comments
                // would otherwise let large option interfaces dominate lexical ranking.
                if (!isTypeLike) fields.set(id, {
                  name: tokenize(name),
                  path: tokenize(file),
                  signature: tokenize(signature),
                  identifiers: identifierTokens,
                  literals: literalTokens,
                });
                return;
              }
              ts.forEachChild(node, child => visit(child, isContainer && ownName ? [...parents, ownName] : parents));
            };
            visit(source, []);
            cached = { version, nodes: declarations, fields };
            this.cache.set(full, cached);
          }
          nodes.push(...cached.nodes);
        }
      }
    };
    walk(root);
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
    return { nodes, scannedFiles, warnings: unique(warnings) };
  }

  /** Type-level declarations (interfaces, type aliases, enums, member-less classes) carry no lexical fields. */
  isTypeLevel(node: CodeNode): boolean {
    const cached = this.cache.get(path.resolve(this.root, node.file));
    return cached !== undefined && !cached.fields.has(node.id);
  }

  lexicalRank(task: string, maxCandidates: number, maxFiles: number, signal?: AbortSignal, inventory: ScanResult = this.scan(maxFiles, signal)) {
    const queryTerms = unique(tokenize(task).filter(term => !stopWords.has(term)));
    const fieldById = new Map<string, SearchFields>();
    for (const cached of this.cache.values()) for (const [id, fields] of cached.fields) fieldById.set(id, fields);
    const documents = inventory.nodes.flatMap(node => {
      const fields = fieldById.get(node.id);
      return fields ? [{ node, fields }] : [];
    });
    const fieldNames: Array<keyof SearchFields> = ['name', 'path', 'signature', 'identifiers', 'literals'];
    const weights: Record<keyof SearchFields, number> = { name: 5, path: 2, signature: 3, identifiers: 1, literals: 2 };
    const averages = Object.fromEntries(fieldNames.map(field => [
      field,
      documents.length ? documents.reduce((sum, document) => sum + document.fields[field].length, 0) / documents.length : 1,
    ])) as Record<keyof SearchFields, number>;
    const df = new Map<string, number>();
    for (const document of documents) {
      const terms = new Set(fieldNames.flatMap(field => document.fields[field]));
      for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
    }

    const scored = documents.map(({ node, fields }) => {
      let bm25Score = 0;
      let exactScore = 0;
      let pathScore = 0;
      const evidence: string[] = [];
      const normalizedName = fields.name.join(' ');
      const normalizedSignature = fields.signature.join(' ');
      const normalizedLiterals = fields.literals.join(' ');
      for (const term of queryTerms) {
        const frequency = df.get(term) ?? 0;
        if (frequency) {
          const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
          for (const field of fieldNames) {
            bm25Score += weights[field] * bm25(count(fields[field], term), fields[field].length, averages[field], idf);
          }
        }
        if (fields.name.includes(term)) exactScore += 6;
        if (fields.identifiers.includes(term)) exactScore += 2;
        if (fields.literals.includes(term)) exactScore += 2;
        if (normalizedName.includes(term) || normalizedSignature.includes(term) || normalizedLiterals.includes(term)) exactScore += 0.5;
        if (fields.path.includes(term)) pathScore += 3;
        if (fields.path.some(segment => segment.includes(term))) pathScore += 0.5;
        if (fieldNames.some(field => fields[field].includes(term))) evidence.push(term);
      }
      return { node, bm25Score, exactScore, pathScore, evidence: unique(evidence) };
    });

    const rankPositive = (pick: (item: typeof scored[number]) => number) =>
      scored.filter(item => pick(item) > 0).sort((a, b) => pick(b) - pick(a)
        || a.node.file.localeCompare(b.node.file) || a.node.startLine - b.node.startLine);
    const bm25Rank = rankPositive(item => item.bm25Score);
    const exactRank = rankPositive(item => item.exactScore);
    const pathRank = rankPositive(item => item.pathScore);
    const rrf = new Map<string, number>();
    for (const ranking of [bm25Rank, exactRank, pathRank]) {
      ranking.forEach((item, index) => rrf.set(item.node.id, (rrf.get(item.node.id) ?? 0) + 1 / (60 + index + 1)));
    }
    const fused: RankedNode[] = scored
      .filter(item => (rrf.get(item.node.id) ?? 0) > 0)
      .map(item => ({ ...item, retrievalScore: rrf.get(item.node.id) ?? 0 }))
      .sort((a, b) => b.retrievalScore - a.retrievalScore
        || b.bm25Score - a.bm25Score || b.exactScore - a.exactScore || b.pathScore - a.pathScore
        || a.node.file.localeCompare(b.node.file) || a.node.startLine - b.node.startLine);
    // Best declaration score per file, over every matched declaration rather than only the top-k.
    const fileScores = new Map<string, number>();
    for (const item of fused) fileScores.set(item.node.file, Math.max(fileScores.get(item.node.file) ?? 0, item.retrievalScore));

    return {
      ...inventory,
      candidates: fused.slice(0, maxCandidates),
      fileScores,
      totalRanked: fused.length,
      signalRanks: { bm25: bm25Rank.length, exact: exactRank.length, path: pathRank.length },
    };
  }

  fileDiscoveryInventory(maxFiles: number, signal?: AbortSignal, inventory: ScanResult = this.scan(maxFiles, signal)) {
    const byFile = new Map<string, CodeNode[]>();
    for (const node of inventory.nodes) {
      const nodes = byFile.get(node.file) ?? [];
      nodes.push(node);
      byFile.set(node.file, nodes);
    }
    const allFiles = [...this.cache.keys()]
      .map(file => path.relative(path.resolve(this.root), file).replaceAll('\\', '/'))
      .sort();
    for (const file of allFiles) if (!byFile.has(file)) byFile.set(file, []);

    // Adaptive scopes: a directory stays one scope while its subtree is small; larger subtrees are split
    // into their child directories (direct files keep a scope of their own). Fixed-depth buckets could
    // put thousands of files behind one decision, or split a small repository into needless scopes.
    const directoryBuckets = new Map<string, string[]>();
    const directOnly = new Set<string>();
    const split = (directory: string, files: string[]): void => {
      const prefix = directory === '.' ? '' : `${directory}/`;
      const own: string[] = [];
      const children = new Map<string, string[]>();
      for (const file of files) {
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) { own.push(file); continue; }
        const child = prefix + rest.slice(0, slash);
        const childFiles = children.get(child) ?? [];
        childFiles.push(file);
        children.set(child, childFiles);
      }
      if (files.length <= maxScopeFiles || !children.size) {
        directoryBuckets.set(directory, files);
        return;
      }
      if (own.length) { directoryBuckets.set(directory, own); directOnly.add(directory); }
      for (const [child, childFiles] of children) split(child, childFiles);
    };
    if (allFiles.length) split('.', allFiles);

    const directoryNodes: CodeNode[] = [...directoryBuckets.entries()].map(([directory, files]) => ({
      id: `dir::${directory}`,
      name: directory,
      file: directory,
      startLine: 1,
      endLine: 1,
      signature: directOnly.has(directory) ? `Repository directory ${directory} (direct files only; subdirectories are separate scopes)` : `Repository directory ${directory}`,
      source: `Files in ${directory}:\n${files.slice(0, 120).join('\n')}`,
    }));

    const makeFileNode = (file: string): CodeNode => {
      const symbols = (byFile.get(file) ?? []).sort((a, b) => a.startLine - b.startLine);
      const summary = symbols.slice(0, 80).map(node => `${node.startLine}: ${node.name} :: ${node.signature.replace(/\s+/g, ' ').slice(0, 180)}`).join('\n');
      return {
        id: `file::${file}`,
        name: file,
        file,
        startLine: 1,
        endLine: 1,
        signature: `Repository file ${file}`,
        source: `Symbols in ${file}:\n${summary || '(no callable symbols)'}`,
      };
    };

    return {
      ...inventory,
      tree: buildTree(allFiles),
      directoryNodes,
      filesByDirectory: directoryBuckets,
      makeFileNode,
      symbolsByFile: byFile,
      totalFiles: allFiles.length,
    };
  }
}

function toLead(item: RankedNode): EntryLead {
  return {
    file: item.node.file,
    line: item.node.startLine,
    endLine: item.node.endLine,
    name: item.node.name,
    signature: item.node.signature,
    retrievalScore: item.retrievalScore,
    lexicalScore: item.retrievalScore,
    bm25Score: item.bm25Score,
    exactScore: item.exactScore,
    pathScore: item.pathScore,
    evidence: item.evidence,
  };
}

/** A provider call inside one discovery stage failed; discovery degrades to lexical leads. */
class JevStageFailure extends Error {}

async function callJudge<T>(stage: string, signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new JevStageFailure(`${stage} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function combineStats(...stats: JudgeCallStats[]): JudgeCallStats {
  return { batches: stats.flatMap(stat => stat.batches) };
}

export async function discoverEntries(
  index: RepositoryIndex,
  judge: RelevanceJudge,
  task: string,
  options: DiscoveryOptions = {},
  adapter?: LanguageAdapter,
): Promise<DiscoveryResult> {
  if (!task.trim()) throw new Error('Task must not be empty');
  const maxCandidates = options.maxCandidates ?? 64;
  const maxLeads = options.maxLeads ?? 4;
  const maxFiles = options.maxFiles ?? 3000;
  const maxJevFiles = options.maxJevFiles ?? 256;
  const maxRelevantDirectories = options.maxRelevantDirectories ?? 8;
  const maxRelevantFiles = options.maxRelevantFiles ?? 8;
  const minLeadScore = options.minLeadScore ?? 0.3;
  const minFileScore = options.minFileScore ?? 0.3;
  const lexicalRescueFiles = options.lexicalRescueFiles ?? 4;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 128) throw new Error('maxCandidates must be between 1 and 128');
  if (!Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > 8) throw new Error('maxLeads must be between 1 and 8');
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000) throw new Error('maxFiles must be between 1 and 10000');
  if (!Number.isInteger(maxJevFiles) || maxJevFiles < 1 || maxJevFiles > 1000) throw new Error('maxJevFiles must be between 1 and 1000');
  if (!Number.isInteger(maxRelevantDirectories) || maxRelevantDirectories < 1 || maxRelevantDirectories > 32) throw new Error('maxRelevantDirectories must be between 1 and 32');
  if (!Number.isInteger(maxRelevantFiles) || maxRelevantFiles < 1 || maxRelevantFiles > 32) throw new Error('maxRelevantFiles must be between 1 and 32');
  if (!Number.isInteger(lexicalRescueFiles) || lexicalRescueFiles < 0 || lexicalRescueFiles > 16) throw new Error('lexicalRescueFiles must be between 0 and 16');
  if (minLeadScore < 0 || minLeadScore > 1 || minFileScore < 0 || minFileScore > 1) throw new Error('Discovery score thresholds must be between 0 and 1');

  options.signal?.throwIfAborted();
  const started = performance.now();
  // One inventory scan per query, shared by lexical ranking and repository-structure discovery.
  const inventory = index.scan(maxFiles, options.signal);
  const lexical = index.lexicalRank(task, maxCandidates, maxFiles, options.signal, inventory);
  const lexicalCandidates = lexical.candidates.map(toLead);
  const warnings = [...lexical.warnings];
  if (lexical.totalRanked > lexicalCandidates.length) {
    warnings.push(`Lexical RRF retained ${lexicalCandidates.length} of ${lexical.totalRanked} matched declarations`);
  }

  const emptyStats: JudgeCallStats = { batches: [] };
  const lexicalResult = (): DiscoveryResult => {
    const semanticLeads = lexicalCandidates.slice(0, maxLeads);
    const selected = semanticLeads[0];
    return {
      task,
      mode: 'lexical',
      status: !selected ? 'no-match' : warnings.length ? 'incomplete' : 'complete',
      lexicalCandidates,
      localCandidates: lexicalCandidates,
      directoryLeads: [],
      fileLeads: [],
      rescuedFiles: [],
      leads: lexicalCandidates,
      semanticLeads,
      selected,
      scannedFiles: lexical.scannedFiles,
      declarations: lexical.nodes.length,
      judgedCandidates: 0,
      latencyMs: performance.now() - started,
      judgeStats: emptyStats,
      directoryJudgeStats: emptyStats,
      fileJudgeStats: emptyStats,
      symbolJudgeStats: emptyStats,
      stageLatencyMs: { directory: 0, file: 0, symbol: 0 },
      warnings,
    };
  };

  if (!(judge.judgeFiles && judge.judgeEntries)) {
    warnings.push('Jev repository-structure discovery is disabled; lexical top-k leads are used for this ablation');
    return lexicalResult();
  }
  try {
    return await semanticDiscovery();
  } catch (error) {
    // A failed provider stage degrades to the lexical leads instead of failing the whole retrieval.
    if (!(error instanceof JevStageFailure)) throw error;
    warnings.push(`Jev discovery failed at ${error.message}; lexical top-k leads are used instead`);
    return lexicalResult();
  }

  async function semanticDiscovery(): Promise<DiscoveryResult> {
    const fileInventory = index.fileDiscoveryInventory(maxFiles, options.signal, inventory);
    const useLexical = options.includeLexicalHints !== false;
    const lexicalHintNodes = useLexical ? lexical.candidates.slice(0, 12).map(candidate => candidate.node) : [];
    let invalidScores = 0;
    const scoreOf = (decisions: Map<string, Judgment>, id: string): number => {
      const score = decisions.get(id)?.score;
      if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) {
        invalidScores++;
        return 0;
      }
      return score;
    };

    let directoryLatencyMs = 0;
    let directoryJudgeStats: JudgeCallStats = emptyStats;
    let directoryScores: DirectoryLead[] = [];
    if (fileInventory.directoryNodes.length === 1) {
      const onlyDirectory = fileInventory.directoryNodes[0];
      directoryScores = [{ directory: onlyDirectory.file, score: 1 }];
    } else if (fileInventory.directoryNodes.length > 1) {
      const directoryStarted = performance.now();
      const directoryJudgments = await callJudge('directory stage', options.signal, () => judge.judgeFiles!(
        task,
        fileInventory.directoryNodes,
        { tree: fileInventory.tree, lexicalHints: lexicalHintNodes },
        options.signal,
      ));
      directoryLatencyMs = performance.now() - directoryStarted;
      directoryJudgeStats = directoryJudgments.stats;
      directoryScores = fileInventory.directoryNodes
        .map(directoryNode => ({ directory: directoryNode.file, score: scoreOf(directoryJudgments.decisions, directoryNode.id) }))
        .sort((a, b) => b.score - a.score || a.directory.localeCompare(b.directory));
    }
    const selectedDirectories = directoryScores.filter(item => item.score >= minFileScore).slice(0, maxRelevantDirectories);

    // Lexically stronger files come first inside each scope, so the maxJevFiles cap drops the weakest
    // files rather than the alphabetically last ones.
    const lexicalFileScore = (file: string): number => useLexical ? lexical.fileScores.get(file) ?? 0 : 0;
    const directoryFileLists = selectedDirectories.map(item => [...(fileInventory.filesByDirectory.get(item.directory) ?? [])]
      .sort((a, b) => lexicalFileScore(b) - lexicalFileScore(a) || a.localeCompare(b)));
    const candidateFiles: string[] = [];
    let fileOffset = 0;
    while (candidateFiles.length < maxJevFiles && directoryFileLists.some(files => fileOffset < files.length)) {
      for (const files of directoryFileLists) {
        if (candidateFiles.length >= maxJevFiles) break;
        const file = files[fileOffset];
        if (file) candidateFiles.push(file);
      }
      fileOffset++;
    }
    const scopedFileCount = directoryFileLists.reduce((sum, files) => sum + files.length, 0);
    if (scopedFileCount > candidateFiles.length) warnings.push(`Jev directory pass selected ${scopedFileCount} files; file evaluation was capped at maxJevFiles=${maxJevFiles}`);

    // Lexical rescue: the files of the strongest lexical matches are always judged at file level,
    // even when their scope lost the directory decision or the file cap. Jev still has to select them.
    const rescuedFiles: string[] = [];
    if (useLexical && lexicalRescueFiles > 0) {
      const topLexicalFiles = unique(lexical.candidates.map(candidate => candidate.node.file)).slice(0, lexicalRescueFiles);
      const candidateSet = new Set(candidateFiles);
      for (const file of topLexicalFiles) if (!candidateSet.has(file)) rescuedFiles.push(file);
      candidateFiles.push(...rescuedFiles);
    }

    const fileNodes = candidateFiles.map(fileInventory.makeFileNode);
    const fileStarted = performance.now();
    const fileJudgments = fileNodes.length
      ? await callJudge('file stage', options.signal, () => judge.judgeFiles!(task, fileNodes, { tree: fileInventory.tree, lexicalHints: lexicalHintNodes }, options.signal))
      : { decisions: new Map<string, Judgment>(), stats: emptyStats };
    const fileLatencyMs = performance.now() - fileStarted;
    const fileLeads: FileLead[] = fileNodes.map(fileNode => ({
      file: fileNode.file,
      score: scoreOf(fileJudgments.decisions, fileNode.id),
      symbols: (fileInventory.symbolsByFile.get(fileNode.file) ?? []).map(node => node.name),
    })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

    const selectedFiles = fileLeads.filter(file => file.score >= minFileScore).slice(0, maxRelevantFiles);
    const symbols = unique(selectedFiles.flatMap(file => fileInventory.symbolsByFile.get(file.file) ?? []));
    const symbolStarted = performance.now();
    const symbolJudgments = symbols.length
      ? await callJudge('symbol stage', options.signal, () => judge.judgeEntries!(task, symbols, options.signal))
      : { decisions: new Map<string, Judgment>(), stats: emptyStats };
    const symbolLatencyMs = performance.now() - symbolStarted;
    const lexicalById = new Map(lexical.candidates.map(candidate => [candidate.node.id, candidate]));
    const leads: EntryLead[] = symbols.map(node => {
      const score = scoreOf(symbolJudgments.decisions, node.id);
      const local = lexicalById.get(node.id);
      return {
        file: node.file,
        line: node.startLine,
        endLine: node.endLine,
        name: node.name,
        signature: node.signature,
        retrievalScore: local?.retrievalScore ?? 0,
        lexicalScore: local?.retrievalScore ?? 0,
        bm25Score: local?.bm25Score,
        exactScore: local?.exactScore,
        pathScore: local?.pathScore,
        score,
        evidence: local?.evidence ?? [],
        ...(index.isTypeLevel(node) ? { typeLevel: true } : {}),
      };
    }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
      || b.retrievalScore - a.retrievalScore || a.file.localeCompare(b.file) || a.line - b.line);
    if (invalidScores) warnings.push(`${invalidScores} Jev discovery answers were missing or invalid and were scored as 0`);

    // Callables are considered before type-level leads: types are usually reached by compiler expansion,
    // and letting them take lead slots displaced needed callables on the development set.
    const qualifying = leads.filter(lead => (lead.score ?? 0) >= minLeadScore);
    const eligible = [...qualifying.filter(lead => !lead.typeLevel), ...qualifying.filter(lead => lead.typeLevel)];
    const semanticLeads: EntryLead[] = [];
    const deferred: EntryLead[] = [];
    const graphCache = new Map<string, Set<string>>();
    const graphSet = (lead: EntryLead): Set<string> => {
      const key = `${lead.file}:${lead.line}:${lead.endLine}`;
      const cached = graphCache.get(key);
      if (cached) return cached;
      const ids = new Set<string>();
      if (adapter) {
        try {
          const node = adapter.findEntry({ file: lead.file, line: lead.line, endLine: lead.endLine, symbol: lead.name });
          ids.add(node.id);
          for (const edge of [...adapter.dependencies(node).edges, ...adapter.reverseDependencies(node).edges]) ids.add(edge.target.id);
        } catch {
          // Diversity is best effort. Stage 3 will surface resolution failures.
        }
      }
      graphCache.set(key, ids);
      return ids;
    };

    for (const lead of eligible) {
      if (semanticLeads.length >= maxLeads) break;
      const candidateGraph = graphSet(lead);
      const overlaps = semanticLeads.some(selected => {
        if (selected.file === lead.file && selected.line === lead.line) return true;
        const selectedGraph = graphSet(selected);
        if (!candidateGraph.size || !selectedGraph.size) return false;
        const intersection = [...candidateGraph].filter(id => selectedGraph.has(id)).length;
        const denominator = Math.min(candidateGraph.size, selectedGraph.size);
        return denominator > 0 && intersection / denominator >= 0.5;
      });
      if (overlaps) deferred.push(lead);
      else semanticLeads.push(lead);
    }
    const minimumLeads = Math.min(2, eligible.length, maxLeads);
    for (const lead of deferred) {
      if (semanticLeads.length >= minimumLeads) break;
      semanticLeads.push(lead);
    }

    const selected = semanticLeads[0];
    if (!selectedFiles.length) warnings.push('Jev file-tree discovery found no file above minFileScore');
    else if (!semanticLeads.length) warnings.push('Jev symbol discovery found no semantic lead above minLeadScore');

    const fileJudgeStats = fileJudgments.stats;
    const symbolJudgeStats = symbolJudgments.stats;
    return {
      task,
      mode: 'parallel-jev',
      status: !selected ? 'no-match' : warnings.length ? 'incomplete' : 'complete',
      lexicalCandidates,
      localCandidates: lexicalCandidates,
      directoryLeads: directoryScores,
      fileLeads,
      rescuedFiles,
      leads,
      semanticLeads,
      selected,
      scannedFiles: lexical.scannedFiles,
      declarations: lexical.nodes.length,
      judgedCandidates: (fileInventory.directoryNodes.length > 1 ? fileInventory.directoryNodes.length : 0) + fileNodes.length + symbols.length,
      latencyMs: performance.now() - started,
      judgeStats: combineStats(directoryJudgeStats, fileJudgeStats, symbolJudgeStats),
      directoryJudgeStats,
      fileJudgeStats,
      symbolJudgeStats,
      stageLatencyMs: { directory: directoryLatencyMs, file: fileLatencyMs, symbol: symbolLatencyMs },
      warnings,
    };
  }
}
