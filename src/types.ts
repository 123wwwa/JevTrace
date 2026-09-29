export type EdgeKind = 'import' | 'call' | 'new' | 'method' | 'jsx' | 'type' | 'caller' | 'test' | 'lexical';
export type ContextLevel = 'body' | 'signature' | 'omitted';

export interface SourceLocation { file: string; line: number; endLine?: number; text?: string }
export interface EntryInput { file: string; line?: number; endLine?: number; symbol?: string; score?: number }

export interface CodeNode {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  source: string;
  signature: string;
  external?: boolean;
}

export interface Dependency {
  kind: EdgeKind;
  target: CodeNode;
  site: SourceLocation;
}

export interface Unresolved { kind: EdgeKind; site: SourceLocation; expression: string; reason: string }
export interface DependencyScan { edges: Dependency[]; unresolved: Unresolved[] }

export interface SupportingContext {
  name: string;
  file: string;
  kind: 'value' | 'type';
  signature: string;
  source: string;
}

export interface LanguageAdapter {
  readonly language: string;
  findEntry(input: EntryInput): CodeNode;
  dependencies(node: CodeNode): DependencyScan;
  reverseDependencies(node: CodeNode): DependencyScan;
  supportingContext?(node: CodeNode): SupportingContext[];
}

export interface Candidate {
  node: CodeNode;
  kind: EdgeKind;
  from: string;
  depth: number;
  site: SourceLocation;
  supportingContext?: SupportingContext[];
}

export interface Judgment {
  include: boolean;
  score?: number;
}

export interface ProviderBatchStats {
  candidates: number;
  payloadBytes: number;
  latencyMs: number;
  cacheHit: boolean;
  attempts: number;
  /** Answers that were missing or outside [0, 1]; those candidates are left undecided instead of failing the batch. */
  invalidAnswers?: number;
}

export interface JudgeCallStats {
  batches: ProviderBatchStats[];
}

export interface JudgeCallResult {
  decisions: Map<string, Judgment>;
  stats: JudgeCallStats;
}

export interface FileDiscoveryContext {
  tree: string;
  lexicalHints?: CodeNode[];
}

export interface RelevanceJudge {
  readonly name: string;
  judgeFiles?(task: string, candidates: CodeNode[], context: FileDiscoveryContext, signal?: AbortSignal): Promise<JudgeCallResult>;
  judgeEntries?(task: string, candidates: CodeNode[], signal?: AbortSignal): Promise<JudgeCallResult>;
  judge(task: string, entry: CodeNode, candidates: Candidate[], signal?: AbortSignal): Promise<Map<string, Judgment>>;
  judgeWithStats?(task: string, entry: CodeNode, candidates: Candidate[], signal?: AbortSignal): Promise<JudgeCallResult>;
  rankContext?(task: string, candidates: Candidate[], signal?: AbortSignal): Promise<JudgeCallResult>;
  chooseNext?(task: string, entry: CodeNode, candidates: Candidate[], signal?: AbortSignal): Promise<string>;
}
