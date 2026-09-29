import { performance } from 'node:perf_hooks';
import type { Candidate, CodeNode, EdgeKind, JudgeCallStats, LanguageAdapter, RelevanceJudge, SourceLocation, Unresolved } from './types.js';
import { discoverEntries, type DiscoveryOptions, type DiscoveryResult, type RepositoryIndex } from './discovery.js';
import type { ContextItem, JudgeRoundTrace, RetrievalOptions, RetrievalResult } from './retrieve.js';

export interface TaskPipelineOptions extends RetrievalOptions, DiscoveryOptions {
  perLeadNodeLimit?: number;
  perLeadTokenBudget?: number;
  neighborhoodTokenBudget?: number;
  lexicalMergeLimit?: number;
  includeLexicalParallel?: boolean;
  includeCompilerExpansion?: boolean;
  contextRanking?: 'jev' | 'structural';
}

export interface NeighborhoodItem {
  node: CodeNode;
  depth: 0 | 1;
  kinds: EdgeKind[];
  leadIds: string[];
  leadNames: string[];
  sources: Array<'semantic-lead' | 'compiler' | 'lexical'>;
  site?: SourceLocation;
  structuralScore: number;
  semanticScore?: number;
  finalScore?: number;
  estimatedTokens: number;
}

export interface NeighborhoodStats {
  rawSymbols: number;
  rawTokens: number;
  cappedSymbols: number;
  cappedTokens: number;
  perLeadPruned: number;
  totalPruned: number;
}

export interface RankingPoolStats {
  symbols: number;
  tokens: number;
  lexicalAdded: number;
}

export interface TaskPipelineResult extends RetrievalResult {
  discovery: DiscoveryResult;
  semanticLeads: CodeNode[];
  neighborhood: { items: NeighborhoodItem[]; stats: NeighborhoodStats };
  rankingPool: { items: NeighborhoodItem[]; stats: RankingPoolStats };
  contextRankingApplied: boolean;
  contextRankingLatencyMs: number;
  contextJudgeStats: JudgeCallStats;
}

const estimate = (node: CodeNode): number => Math.ceil((node.external ? node.signature.length : node.source.length) / 4);
const edgePrior: Record<EdgeKind, number> = {
  caller: 0.95,
  call: 0.92,
  method: 0.92,
  new: 0.9,
  jsx: 0.88,
  test: 0.86,
  import: 0.72,
  type: 0.55,
  lexical: 0.5,
};
const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'to', 'of', 'for', 'in', 'on', 'and', 'or', 'how', 'change', 'fix', 'add', 'implement', 'with', 'when', 'should', 'from']);
const taskTokens = (text: string): Set<string> => new Set(
  (text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(term => term.length > 1 && !stopWords.has(term)),
);
const lexicalEdgeScore = (name: string, file: string, site: SourceLocation | undefined, terms: Set<string>): number => {
  const haystack = `${name} ${file} ${site?.text ?? ''}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score++;
  return score;
};
export async function retrieveTaskContext(
  index: RepositoryIndex,
  adapter: LanguageAdapter,
  discoveryJudge: RelevanceJudge,
  contextJudge: RelevanceJudge,
  task: string,
  options: TaskPipelineOptions = {},
): Promise<TaskPipelineResult | { task: string; status: 'incomplete'; discovery: DiscoveryResult; warnings: string[] }> {
  options.signal?.throwIfAborted();
  const tokenBudget = options.tokenBudget ?? 8000;
  const maxLeads = options.maxLeads ?? 4;
  const perLeadNodeLimit = options.perLeadNodeLimit ?? 24;
  const perLeadTokenBudget = options.perLeadTokenBudget ?? tokenBudget;
  const neighborhoodTokenBudget = options.neighborhoodTokenBudget ?? tokenBudget * 2;
  const lexicalMergeLimit = options.lexicalMergeLimit ?? (options.maxCandidates ?? 64);
  const includeLexicalParallel = options.includeLexicalParallel === true;
  const includeCompilerExpansion = options.includeCompilerExpansion !== false;
  const reverseFanIn = options.reverseFanIn ?? 12;
  const contextRanking = options.contextRanking ?? 'jev';

  if (!Number.isInteger(perLeadNodeLimit) || perLeadNodeLimit < 1 || perLeadNodeLimit > 100) throw new Error('perLeadNodeLimit must be between 1 and 100');
  if (!Number.isInteger(perLeadTokenBudget) || perLeadTokenBudget < 100) throw new Error('perLeadTokenBudget must be at least 100');
  if (!Number.isInteger(neighborhoodTokenBudget) || neighborhoodTokenBudget < tokenBudget) throw new Error('neighborhoodTokenBudget must be >= tokenBudget');
  if (!Number.isInteger(lexicalMergeLimit) || lexicalMergeLimit < 0 || lexicalMergeLimit > 128) throw new Error('lexicalMergeLimit must be between 0 and 128');

  const discovery = await discoverEntries(
    index,
    discoveryJudge,
    task,
    { ...options, maxCandidates: options.maxCandidates ?? 64, maxLeads },
    adapter,
  );
  if (!discovery.semanticLeads.length) {
    return {
      task,
      status: 'incomplete',
      discovery,
      warnings: [...discovery.warnings, 'No semantic leads found; inspect Jev file/symbol discovery or use the lexical-only ablation'],
    };
  }

  const terms = taskTokens(task);
  const unresolved: Unresolved[] = [];
  const warnings = [...discovery.warnings];
  let reversePruned = 0;
  let perLeadPruned = 0;
  const rawCompiler = new Map<string, NeighborhoodItem>();
  const cappedCompiler = new Map<string, NeighborhoodItem>();
  const semanticLeads: CodeNode[] = [];

  const merge = (target: Map<string, NeighborhoodItem>, item: NeighborhoodItem) => {
    const existing = target.get(item.node.id);
    if (!existing) {
      target.set(item.node.id, { ...item, kinds: [...item.kinds], leadIds: [...item.leadIds], leadNames: [...item.leadNames], sources: [...item.sources] });
      return;
    }
    existing.structuralScore = Math.max(existing.structuralScore, item.structuralScore);
    existing.semanticScore = Math.max(existing.semanticScore ?? 0, item.semanticScore ?? 0) || undefined;
    existing.depth = Math.min(existing.depth, item.depth) as 0 | 1;
    existing.kinds = [...new Set([...existing.kinds, ...item.kinds])];
    existing.leadIds = [...new Set([...existing.leadIds, ...item.leadIds])];
    existing.leadNames = [...new Set([...existing.leadNames, ...item.leadNames])];
    existing.sources = [...new Set([...existing.sources, ...item.sources])];
    if (!existing.site && item.site) existing.site = item.site;
  };

  for (const lead of discovery.semanticLeads.slice(0, maxLeads)) {
    options.signal?.throwIfAborted();
    const node = adapter.findEntry({ file: lead.file, line: lead.line, endLine: lead.endLine, symbol: lead.name, score: lead.score });
    semanticLeads.push(node);
    const leadItem: NeighborhoodItem = {
      node,
      depth: 0,
      kinds: [],
      leadIds: [node.id],
      leadNames: [node.name],
      sources: ['semantic-lead'],
      structuralScore: 1,
      semanticScore: lead.score,
      estimatedTokens: estimate(node),
    };
    merge(rawCompiler, leadItem);
    if (!includeCompilerExpansion) {
      merge(cappedCompiler, leadItem);
      continue;
    }

    const forward = adapter.dependencies(node);
    const reverse = adapter.reverseDependencies(node);
    unresolved.push(...forward.unresolved, ...reverse.unresolved);
    let reverseEdges = reverse.edges;
    if (reverseEdges.length > reverseFanIn) {
      const before = reverseEdges.length;
      reverseEdges = reverseEdges
        .map(edge => ({ edge, taskScore: lexicalEdgeScore(edge.target.name, edge.target.file, edge.site, terms), prior: edgePrior[edge.kind] }))
        .sort((a, b) => b.taskScore - a.taskScore || b.prior - a.prior || a.edge.target.id.localeCompare(b.edge.target.id))
        .slice(0, reverseFanIn)
        .map(item => item.edge);
      reversePruned += before - reverseEdges.length;
    }

    const candidates = [...forward.edges, ...reverseEdges].map(edge => ({
      item: {
        node: edge.target,
        depth: 1 as const,
        kinds: [edge.kind],
        leadIds: [node.id],
        leadNames: [node.name],
        sources: ['compiler'] as Array<'compiler'>,
        site: edge.site,
        structuralScore: edgePrior[edge.kind],
        estimatedTokens: estimate(edge.target),
      } satisfies NeighborhoodItem,
      taskScore: lexicalEdgeScore(edge.target.name, edge.target.file, edge.site, terms),
    }));
    for (const { item } of candidates) merge(rawCompiler, item);

    candidates.sort((a, b) =>
      b.item.structuralScore - a.item.structuralScore
      || b.taskScore - a.taskScore
      || a.item.node.id.localeCompare(b.item.node.id));

    let leadTokens = leadItem.estimatedTokens;
    let leadNodes = 1;
    merge(cappedCompiler, leadItem);
    for (const { item } of candidates) {
      if (leadNodes >= perLeadNodeLimit || leadTokens + item.estimatedTokens > perLeadTokenBudget) {
        perLeadPruned++;
        continue;
      }
      merge(cappedCompiler, item);
      leadTokens += item.estimatedTokens;
      leadNodes++;
    }
  }

  const rawCompilerItems = [...rawCompiler.values()];
  const rawTokens = rawCompilerItems.reduce((sum, item) => sum + item.estimatedTokens, 0);
  let compilerItems = [...cappedCompiler.values()].sort((a, b) =>
    b.structuralScore - a.structuralScore || a.depth - b.depth || a.node.id.localeCompare(b.node.id));
  const beforeTotalCap = compilerItems.length;
  let cappedTokens = 0;
  compilerItems = compilerItems.filter(item => {
    if (cappedTokens + item.estimatedTokens > neighborhoodTokenBudget) return false;
    cappedTokens += item.estimatedTokens;
    return true;
  });
  const totalPruned = beforeTotalCap - compilerItems.length;
  if (perLeadPruned) warnings.push(`${perLeadPruned} per-lead compiler candidates were pruned by node/token bounds`);
  if (totalPruned) warnings.push(`${totalPruned} merged compiler candidates were pruned by neighborhoodTokenBudget=${neighborhoodTokenBudget}`);
  if (reversePruned) warnings.push(`${reversePruned} reverse caller/test edges were pruned by reverseFanIn=${reverseFanIn}`);

  const neighborhoodStats: NeighborhoodStats = {
    rawSymbols: rawCompilerItems.length,
    rawTokens,
    cappedSymbols: compilerItems.length,
    cappedTokens,
    perLeadPruned,
    totalPruned,
  };

  const rankingPool = new Map<string, NeighborhoodItem>();
  for (const item of compilerItems) merge(rankingPool, item);
  let lexicalAdded = 0;
  if (includeLexicalParallel && lexicalMergeLimit > 0) {
    const lexical = discovery.lexicalCandidates.slice(0, lexicalMergeLimit);
    for (let rank = 0; rank < lexical.length; rank++) {
      const lead = lexical[rank];
      try {
        const node = adapter.findEntry({ file: lead.file, line: lead.line, endLine: lead.endLine, symbol: lead.name });
        const before = rankingPool.has(node.id);
        const rankFraction = lexical.length <= 1 ? 0 : rank / (lexical.length - 1);
        const lexicalPrior = 0.8 - 0.4 * rankFraction;
        merge(rankingPool, {
          node,
          depth: 0,
          kinds: ['lexical'],
          leadIds: [],
          leadNames: [],
          sources: ['lexical'],
          structuralScore: lexicalPrior,
          estimatedTokens: estimate(node),
        });
        if (!before) lexicalAdded++;
      } catch {
        warnings.push(`Lexical parallel candidate could not be resolved: ${lead.file}:${lead.line}`);
      }
    }
  }

  const rankingItems = [...rankingPool.values()];
  const rankingTokens = rankingItems.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const rankingPoolStats: RankingPoolStats = { symbols: rankingItems.length, tokens: rankingTokens, lexicalAdded };

  let contextRankingApplied = false;
  let contextRankingLatencyMs = 0;
  let contextJudgeStats: JudgeCallStats = { batches: [] };
  if (rankingTokens > tokenBudget && contextRanking === 'jev') {
    const judgeCandidates: Candidate[] = rankingItems.map(item => ({
      node: item.node,
      kind: item.kinds[0] ?? 'lexical',
      from: item.leadNames[0] ?? '<parallel-discovery>',
      depth: item.depth,
      site: item.site ?? { file: item.node.file, line: item.node.startLine },
      supportingContext: adapter.supportingContext?.(item.node) ?? [],
    }));

    if (judgeCandidates.length) {
      const syntheticEntry: CodeNode = {
        id: '__jevtrace_parallel_discovery__',
        name: 'JevTrace parallel discovery pool',
        file: '<parallel-discovery>',
        startLine: 1,
        endLine: semanticLeads.length,
        signature: semanticLeads.map(node => `${node.file}::${node.name}`).join('\n'),
        source: semanticLeads.map(node => `// semantic lead ${node.file}::${node.name}\n${node.source.slice(0, 1200)}`).join('\n\n'),
      };
      const contextStarted = performance.now();
      const judged = contextJudge.rankContext
        ? await contextJudge.rankContext(task, judgeCandidates, options.signal)
        : contextJudge.judgeWithStats
          ? await contextJudge.judgeWithStats(task, syntheticEntry, judgeCandidates, options.signal)
          : { decisions: await contextJudge.judge(task, syntheticEntry, judgeCandidates, options.signal), stats: { batches: [] } };
      contextRankingLatencyMs = performance.now() - contextStarted;
      contextJudgeStats = judged.stats;

      for (const item of rankingItems) {
        const semantic = judged.decisions.get(item.node.id)?.score ?? 0;
        item.semanticScore = semantic;
        item.finalScore = 0.7 * semantic + 0.3 * item.structuralScore;
      }
      contextRankingApplied = true;
    }
  }

  if (!contextRankingApplied) {
    for (const item of rankingItems) item.finalScore = item.structuralScore;
  }

  rankingItems.sort((a, b) =>
    (b.finalScore ?? 0) - (a.finalScore ?? 0)
    || b.structuralScore - a.structuralScore
    || a.depth - b.depth
    || a.node.id.localeCompare(b.node.id));

  const selected: NeighborhoodItem[] = [];
  const omittedPool: NeighborhoodItem[] = [];
  let usedTokens = 0;
  for (const item of rankingItems) {
    if (usedTokens + item.estimatedTokens <= tokenBudget) {
      selected.push(item);
      usedTokens += item.estimatedTokens;
    } else omittedPool.push(item);
  }
  if (omittedPool.length) warnings.push(`${omittedPool.length} ranking-pool candidates were omitted by final tokenBudget=${tokenBudget}`);

  const primaryLead = semanticLeads[0];
  const toContextItem = (item: NeighborhoodItem, level: 'body' | 'signature' | 'omitted'): ContextItem => ({
    node: item.node,
    level: item.node.external && level === 'body' ? 'signature' : level,
    path: item.leadNames.length
      ? [item.leadNames[0], item.node.name]
      : [item.node.name],
    from: item.leadIds[0],
    kind: item.kinds[0],
    site: item.site,
    depth: item.depth,
    score: item.finalScore,
  });
  const items = selected.map(item => toContextItem(item, item.node.external ? 'signature' : 'body'));
  const omitted = omittedPool.map(item => toContextItem(item, 'omitted'));
  const batches = contextJudgeStats.batches;
  const judgeTrace: JudgeRoundTrace[] = contextRankingApplied ? [{
    round: 1,
    depth: 1,
    candidates: rankingItems.length,
    latencyMs: batches.reduce((sum, batch) => sum + batch.latencyMs, 0),
    payloadBytes: batches.reduce((sum, batch) => sum + batch.payloadBytes, 0),
    providerBatches: batches.length,
    providerRequests: batches.reduce((sum, batch) => sum + batch.attempts, 0),
    cacheHits: batches.filter(batch => batch.cacheHit).length,
    batchSizes: batches.map(batch => batch.candidates),
    batchLatenciesMs: batches.map(batch => batch.latencyMs),
  }] : [];

  if (unresolved.length) warnings.push(`${unresolved.length} references could not be resolved statically`);

  return {
    task,
    judge: contextRankingApplied ? contextJudge.name : 'structural-budget',
    status: warnings.length || unresolved.length ? 'incomplete' : 'complete',
    entry: primaryLead,
    items,
    omitted,
    unresolved,
    considered: rankingItems.length,
    usedTokens,
    tokenBudget,
    visitPolicy: 'score',
    choiceDecisions: 0,
    wrapperLookahead: false,
    bodyThreshold: 0,
    omitThreshold: 0,
    reverseFanIn,
    reversePruned,
    judgeRounds: contextRankingApplied ? 1 : 0,
    judgeTrace,
    warnings,
    discovery,
    semanticLeads,
    neighborhood: { items: compilerItems, stats: neighborhoodStats },
    rankingPool: { items: rankingItems, stats: rankingPoolStats },
    contextRankingApplied,
    contextRankingLatencyMs,
    contextJudgeStats,
  };
}
