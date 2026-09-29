import { performance } from 'node:perf_hooks';
import type { Candidate, CodeNode, ContextLevel, Dependency, EdgeKind, EntryInput, LanguageAdapter, RelevanceJudge, SourceLocation, Unresolved } from './types.js';

export interface ContextItem {
  node: CodeNode;
  level: ContextLevel;
  path: string[];
  from?: string;
  kind?: EdgeKind;
  site?: SourceLocation;
  depth: number;
  score?: number;
}
export interface JudgeRoundTrace {
  round: number;
  depth: number;
  candidates: number;
  latencyMs: number;
  payloadBytes: number;
  providerBatches: number;
  providerRequests: number;
  cacheHits: number;
  batchSizes: number[];
  batchLatenciesMs: number[];
}

export interface RetrievalResult {
  task: string;
  judge: string;
  status: 'complete' | 'incomplete';
  entry: CodeNode;
  items: ContextItem[];
  omitted: ContextItem[];
  unresolved: Unresolved[];
  considered: number;
  usedTokens: number;
  tokenBudget: number;
  visitPolicy: 'score' | 'choice';
  choiceDecisions: number;
  wrapperLookahead: boolean;
  bodyThreshold: number;
  omitThreshold: number;
  reverseFanIn: number;
  reversePruned: number;
  judgeRounds: number;
  judgeTrace: JudgeRoundTrace[];
  warnings: string[];
}
export interface RetrievalOptions { maxDepth?: number; maxNodes?: number; tokenBudget?: number; reverse?: boolean; reverseFanIn?: number; wrapperLookahead?: boolean; visitPolicy?: 'score' | 'choice'; bodyThreshold?: number; omitThreshold?: number; signal?: AbortSignal }
interface Queued { candidate: Candidate; score: number; path: string[]; wrapper: boolean; priority: number }
const estimate = (text: string): number => Math.ceil(text.length / 4);
const taskWords = (text: string): Set<string> => new Set(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const reverseStopWords = new Set('a an the is are to of for in on and or how change fix add implement with when should from behavior code'.split(' '));
const reverseEdgeScore = (edge: Dependency, terms: Set<string>): number => {
  const haystack = `${edge.target.name} ${edge.target.file} ${edge.target.signature} ${edge.site.text ?? ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  let score = edge.kind === 'test' ? 1 : 0;
  for (const term of terms) if (term.length > 1 && haystack.includes(term)) score++;
  return score;
};

export async function retrieve(adapter: LanguageAdapter, judge: RelevanceJudge, task: string, input: EntryInput, options: RetrievalOptions = {}): Promise<RetrievalResult> {
  const maxDepth = options.maxDepth ?? 4;
  const maxNodes = options.maxNodes ?? 30;
  const tokenBudget = options.tokenBudget ?? 8000;
  const visitPolicy = options.visitPolicy ?? 'score';
  const wrapperLookahead = options.wrapperLookahead !== false;
  const reverseFanIn = options.reverseFanIn ?? 12;
  const bodyThreshold = options.bodyThreshold ?? 0.3;
  const omitThreshold = options.omitThreshold ?? 0.3;
  if (omitThreshold < 0 || omitThreshold > 1 || bodyThreshold < 0 || bodyThreshold > 1 || omitThreshold > bodyThreshold)
    throw new Error('Thresholds must satisfy 0 <= omitThreshold <= bodyThreshold <= 1');
  if (!Number.isInteger(reverseFanIn) || reverseFanIn < 1 || reverseFanIn > 100)
    throw new Error('reverseFanIn must be an integer between 1 and 100');
  if (visitPolicy === 'choice' && !judge.chooseNext) throw new Error('The selected judge does not support Choice visit policy');

  const entry = adapter.findEntry(input);
  const items: ContextItem[] = [{ node: entry, level: 'body', path: [entry.name], depth: 0, score: input.score }];
  const omitted: ContextItem[] = [];
  const unresolved: Unresolved[] = [];
  const warnings: string[] = [];
  const seen = new Set([entry.id]);
  let usedTokens = estimate(entry.source);
  let considered = 0;
  let incomplete = usedTokens > tokenBudget;
  let depthLimited = 0;
  let nodeLimited = 0;
  let budgetLimited = usedTokens > tokenBudget;
  let reversePruned = 0;
  let choiceDecisions = 0;
  let judgeRounds = 0;
  const judgeTrace: JudgeRoundTrace[] = [];
  const reverseTerms = new Set([...taskWords(task)].filter(term => term.length > 1 && !reverseStopWords.has(term)));

  interface Discovered {
    candidate: Candidate;
    path: string[];
    wrapper: boolean;
  }

  const collect = (parent: CodeNode, parentPath: string[], depth: number, reverse = false, mode: 'all' | 'types' | 'runtime' = 'all'): Discovered[] => {
    options.signal?.throwIfAborted();
    const scan = reverse ? adapter.reverseDependencies(parent) : adapter.dependencies(parent);
    if (mode !== 'types') unresolved.push(...scan.unresolved);
    let edges = scan.edges.filter(edge => !seen.has(edge.target.id) &&
      (mode === 'all' || (mode === 'types' ? edge.kind === 'type' : edge.kind !== 'type')));
    if (reverse && edges.length > reverseFanIn) {
      const beforeCap = edges.length;
      edges = edges
        .map(edge => ({ edge, score: reverseEdgeScore(edge, reverseTerms) }))
        .sort((a, b) => b.score - a.score || a.edge.target.id.localeCompare(b.edge.target.id))
        .slice(0, reverseFanIn)
        .map(item => item.edge);
      reversePruned += beforeCap - edges.length;
      incomplete = true;
    }
    for (const edge of edges) seen.add(edge.target.id);
    considered += edges.length;

    return edges.map(({ target, kind, site }) => {
      const candidate: Candidate = { node: target, kind, site, from: parent.id, depth };
      const wrapper = wrapperLookahead && !target.external && target.source.length < 220 &&
        adapter.dependencies(target).edges.filter(edge => edge.kind !== 'type').length === 1;
      return { candidate, path: [...parentPath, target.name], wrapper };
    });
  };

  const judgeFrontier = async (frontier: Discovered[]): Promise<Queued[]> => {
    const judged = frontier
      .filter(item => item.candidate.kind !== 'type')
      .map(item => ({
        ...item.candidate,
        supportingContext: adapter.supportingContext?.(item.candidate.node) ?? [],
      }));
    let decisions = new Map<string, { include: boolean; score?: number }>();

    if (judged.length) {
      const started = performance.now();
      const detailed = judge.judgeWithStats
        ? await judge.judgeWithStats(task, entry, judged, options.signal)
        : undefined;
      decisions = detailed?.decisions ?? await judge.judge(task, entry, judged, options.signal);
      const batches = detailed?.stats.batches ?? [];
      judgeRounds++;
      judgeTrace.push({
        round: judgeRounds,
        depth: judged[0]?.depth ?? frontier[0]?.candidate.depth ?? 0,
        candidates: judged.length,
        latencyMs: performance.now() - started,
        payloadBytes: batches.reduce((sum, batch) => sum + batch.payloadBytes, 0),
        providerBatches: batches.length,
        providerRequests: batches.reduce((sum, batch) => sum + batch.attempts, 0),
        cacheHits: batches.filter(batch => batch.cacheHit).length,
        batchSizes: batches.map(batch => batch.candidates),
        batchLatenciesMs: batches.map(batch => batch.latencyMs),
      });
    }

    return frontier.map(({ candidate, path, wrapper }) => {
      const decision = decisions.get(candidate.node.id);
      if (candidate.kind !== 'type' && !decision) {
        // An undecided candidate scores 0 (omitted) instead of failing the whole retrieval.
        incomplete = true;
        warnings.push(`Relevance judge omitted a decision for ${candidate.node.file}:${candidate.node.startLine}; treated as score 0`);
      }
      const score = candidate.kind === 'type' ? 1 : decision?.score ?? (decision?.include ? 1 : 0);
      const priority = (candidate.kind === 'type' ? 1 : Math.max(score, wrapper ? 0.45 : 0)) * Math.pow(0.8, candidate.depth - 1);
      return { candidate, score, path, wrapper, priority };
    });
  };

  let frontier: Discovered[] = [];
  if (maxDepth > 0) {
    frontier.push(...collect(entry, [entry.name], 1));
    if (options.reverse !== false) frontier.push(...collect(entry, [entry.name], 1, true));
  }

  while (frontier.length) {
    options.signal?.throwIfAborted();
    const queue = await judgeFrontier(frontier);
    const nextFrontier: Discovered[] = [];

    while (queue.length) {
      options.signal?.throwIfAborted();
      queue.sort((a, b) => b.priority - a.priority || a.candidate.node.id.localeCompare(b.candidate.node.id));
      let selectedIndex = 0;
      if (visitPolicy === 'choice' && queue.length > 1) {
        const pool = queue.slice(0, 16);
        const selectedId = await judge.chooseNext!(task, entry, pool.map(item => item.candidate), options.signal);
        selectedIndex = queue.findIndex(item => item.candidate.node.id === selectedId);
        if (selectedIndex < 0 || selectedIndex >= pool.length) throw new Error('Choice selected a candidate outside the offered pool');
        choiceDecisions++;
      }

      const { candidate, score, path, wrapper } = queue.splice(selectedIndex, 1)[0];
      const node = candidate.node;
      let level: ContextLevel = candidate.kind === 'type' || score > bodyThreshold ? 'body' : score >= omitThreshold ? 'signature' : 'omitted';
      if (node.external && level === 'body') level = 'signature';
      if (items.length >= maxNodes && level !== 'omitted') {
        level = 'omitted';
        nodeLimited++;
        incomplete = true;
      }

      let cost = estimate(level === 'body' ? node.source : level === 'signature' ? node.signature : '');
      if (usedTokens + cost > tokenBudget && level === 'body') {
        level = 'signature';
        cost = estimate(node.signature);
        budgetLimited = true;
        incomplete = true;
      }
      if (usedTokens + cost > tokenBudget && level === 'signature') {
        level = 'omitted';
        cost = 0;
        budgetLimited = true;
        incomplete = true;
      }

      const item: ContextItem = { node, level, path, from: candidate.from, kind: candidate.kind, site: candidate.site, depth: candidate.depth, score };
      if (level === 'omitted') omitted.push(item);
      else { items.push(item); usedTokens += cost; }

      if (candidate.depth >= maxDepth && level === 'body' && !node.external &&
          adapter.dependencies(node).edges.some(edge => edge.kind !== 'type' && !seen.has(edge.target.id))) {
        depthLimited++;
        incomplete = true;
      }

      if (!node.external && usedTokens < tokenBudget && candidate.depth < maxDepth) {
        if (level === 'body')
          nextFrontier.push(...collect(node, path, candidate.depth + 1));
        else if (wrapper)
          nextFrontier.push(...collect(node, path, candidate.depth + 1, false, 'runtime'));
        else if (level === 'signature')
          nextFrontier.push(...collect(node, path, candidate.depth + 1, false, 'types'));
      }
    }

    frontier = nextFrontier;
  }

  if (unresolved.length) { incomplete = true; warnings.push(`${unresolved.length} references could not be resolved statically`); }
  if (depthLimited) warnings.push(`${depthLimited} included nodes reached maxDepth=${maxDepth}`);
  if (nodeLimited) warnings.push(`${nodeLimited} candidates were omitted after reaching maxNodes=${maxNodes}`);
  if (budgetLimited) warnings.push(`Context was downgraded or omitted to stay within tokenBudget=${tokenBudget}`);
  if (reversePruned) warnings.push(`${reversePruned} reverse caller/test edges were pruned by reverseFanIn=${reverseFanIn}`);
  return { task, judge: judge.name, status: incomplete ? 'incomplete' : 'complete', entry, items, omitted, unresolved, considered, usedTokens, tokenBudget, visitPolicy, choiceDecisions, wrapperLookahead, bodyThreshold, omitThreshold, reverseFanIn, reversePruned, judgeRounds, judgeTrace, warnings };
}

export function formatContext(result: RetrievalResult, maxChars = 30000): string {
  const lines = [
    `Status: ${result.status} | Judge: ${result.judge} | Visit: ${result.visitPolicy} | Judge rounds: ${result.judgeRounds} | Thresholds: body>${result.bodyThreshold}, omit<${result.omitThreshold} | Context: ~${result.usedTokens}/${result.tokenBudget} tokens`,
    `Task: ${result.task}`,
    `Entry: ${result.entry.file}:${result.entry.startLine} ${result.entry.name}`,
    `Included: ${result.items.length} | Omitted: ${result.omitted.length} | Unresolved: ${result.unresolved.length}`,
    ...result.warnings.map(w => `Warning: ${w}`), '', '## Paths',
    ...result.items.map(item => `- ${item.path.join(' → ')} (${item.kind ?? 'entry'}; ${item.level}; ${item.node.file}:${item.node.startLine})`),
    '', '## Context',
  ];
  for (const item of result.items) {
    lines.push(`### ${item.node.name} — ${item.node.file}:${item.node.startLine}-${item.node.endLine} [${item.level}${item.score === undefined ? '' : `; relevance ${item.score.toFixed(2)}`}]
\`\`\`ts
${item.level === 'body' ? item.node.source : item.node.signature}
\`\`\``);
  }
  lines.push('', '## Omitted', ...result.omitted.map(item => `- ${item.node.name} — ${item.node.file}:${item.node.startLine} (relevance ${item.score?.toFixed(2) ?? 'n/a'})`));
  lines.push('', '## Unresolved', ...result.unresolved.map(item => `- ${item.site.file}:${item.site.line} ${item.expression} — ${item.reason}`));
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars - 35) + '\n[Output character limit reached]' : text;
}
