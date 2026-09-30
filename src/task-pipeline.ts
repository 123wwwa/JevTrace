import { performance } from 'node:perf_hooks';
import type { Candidate, CodeNode, Dependency, EdgeKind, JudgeCallResult, JudgeCallStats, LanguageAdapter, RelevanceJudge, SourceLocation, Unresolved } from './types.js';
import { discoverEntries, type DiscoveryOptions, type DiscoveryResult, type RepositoryIndex } from './discovery.js';
import type { ContextItem, JudgeRoundTrace, RetrievalOptions, RetrievalResult } from './retrieve.js';
import { broadTaskGuidance, broadTaskThreshold, repositoryMap, sourceInventory, suggestSubtasks, type BroadTaskResult } from './broad-task.js';

export interface TaskPipelineOptions extends RetrievalOptions, DiscoveryOptions {
  perLeadNodeLimit?: number;
  perLeadTokenBudget?: number;
  neighborhoodTokenBudget?: number;
  lexicalMergeLimit?: number;
  includeLexicalParallel?: boolean;
  includeCompilerExpansion?: boolean;
  contextRanking?: 'jev' | 'structural';
  /** Ask the discovery judge whether the task is project-wide before returning code (default true). */
  scopeCheck?: boolean;
  /** Size limit of the repository map returned for a project-wide task (default 20,000 characters). */
  mapChars?: number;
}

export interface NeighborhoodItem {
  node: CodeNode;
  /** 0 lead, 1 direct neighbour, 2 sibling (called alongside the lead by its caller). */
  depth: 0 | 1 | 2;
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
const signatureTokens = (node: CodeNode): number => Math.ceil(node.signature.length / 4);
/** Cost charged against a pre-ranking cap: the body when it fits, else the signature it can still be reduced to. */
const capCost = (used: number, item: NeighborhoodItem, cap: number): number | undefined =>
  used + item.estimatedTokens <= cap ? item.estimatedTokens
    : used + signatureTokens(item.node) <= cap ? signatureTokens(item.node) : undefined;
const maxTestCallersPerLead = 3;
const maxSiblingsPerLead = 4;
/** Above this many estimated tokens a non-lead class is returned as its member outline. */
const largeClassTokens = 800;
/** Across all leads; leads are expanded best-first, so the strongest leads' tests are kept. */
const maxTestCallersTotal = 4;
/** Users of type-level leads kept across all of them. */
const maxTypeLeadUsers = 3;
/** A lead with more callers than this is treated as a hub: only its most task-related users are kept. */
const hubCallers = 25;
const edgePrior: Record<EdgeKind, number> = {
  caller: 0.95,
  call: 0.92,
  method: 0.92,
  new: 0.9,
  jsx: 0.88,
  test: 0.86,
  value: 0.8,
  sibling: 0.6,
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
): Promise<TaskPipelineResult | BroadTaskResult | { task: string; status: 'incomplete'; discovery: DiscoveryResult; warnings: string[] }> {
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

  // The scope question runs alongside discovery, so a specific task pays no extra latency; a project-wide
  // task stops discovery, since any code it picked would be arbitrary.
  const discoveryAbort = new AbortController();
  const forwardAbort = () => discoveryAbort.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  let discovery: DiscoveryResult;
  const scopeNotes: string[] = [];
  let scope: Awaited<ReturnType<NonNullable<RelevanceJudge['judgeTaskScope']>>> | undefined;
  try {
    const scopeCheck = options.scopeCheck !== false && discoveryJudge.judgeTaskScope
      ? discoveryJudge.judgeTaskScope(task, options.signal).catch((error: unknown) => {
        options.signal?.throwIfAborted();
        scopeNotes.push(`Task scope check failed; retrieved as a specific task: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      })
      : undefined;
    const discoveryRun = discoverEntries(
      index,
      discoveryJudge,
      task,
      { ...options, maxCandidates: options.maxCandidates ?? 64, maxLeads, signal: discoveryAbort.signal },
      adapter,
    );
    // Rejections after an abort below are expected; the awaited path still sees real failures.
    discoveryRun.catch(() => undefined);
    scope = await scopeCheck;
    if (scope?.specificity !== undefined && scope.specificity < broadTaskThreshold) {
      discoveryAbort.abort(new Error('Project-wide task'));
      const inventory = sourceInventory(index, options.maxFiles);
      const subtasks = suggestSubtasks(task, inventory);
      const guidance = broadTaskGuidance(scope.specificity, subtasks);
      return {
        task, status: 'broad', specificity: scope.specificity, guidance, subtasks,
        map: repositoryMap(inventory, Math.max(500, (options.mapChars ?? 20_000) - guidance.length)),
        warnings: [], scopeStats: scope.stats,
      };
    }
    discovery = await discoveryRun;
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }
  discovery.warnings.push(...scopeNotes);
  // Billed like any other discovery request.
  // A new object: the per-stage stats may share one array.
  if (scope) discovery.judgeStats = { batches: [...discovery.judgeStats.batches, ...scope.stats.batches] };
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
  // warnings: something degraded the result (a failed provider stage, an unresolvable lead). notes: normal
  // bounds and static-analysis limits, reported so they can be inspected without reading as a failure.
  const informational = (message: string) => /^(Task scope check failed|Lexical RRF retained|Jev directory pass selected|Jev repository-structure discovery is disabled|Skipped source larger than 1 MiB)/.test(message)
    || /analysed without their base config/.test(message);
  const warnings = discovery.warnings.filter(message => !informational(message));
  const notes = discovery.warnings.filter(informational);
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
    existing.depth = Math.min(existing.depth, item.depth) as 0 | 1 | 2;
    existing.kinds = [...new Set([...existing.kinds, ...item.kinds])];
    existing.leadIds = [...new Set([...existing.leadIds, ...item.leadIds])];
    existing.leadNames = [...new Set([...existing.leadNames, ...item.leadNames])];
    existing.sources = [...new Set([...existing.sources, ...item.sources])];
    if (!existing.site && item.site) existing.site = item.site;
  };

  let testsKeptTotal = 0;
  let typeUsersKept = 0;
  for (const lead of discovery.semanticLeads.slice(0, maxLeads)) {
    options.signal?.throwIfAborted();
    let node: CodeNode;
    try {
      node = adapter.findEntry({ file: lead.file, line: lead.line, endLine: lead.endLine, symbol: lead.name, score: lead.score });
    } catch (error) {
      // One unresolvable lead must not discard the others.
      warnings.push(`Semantic lead ${lead.file}:${lead.line} (${lead.name}) could not be resolved by the compiler: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
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

    const forward = adapter.dependencies(node, { values: true });
    const reverse = adapter.reverseDependencies(node);
    unresolved.push(...forward.unresolved, ...reverse.unresolved);
    // Most task-related callers first. Tests are capped per lead: a widely used helper can have dozens of
    // test callers, and in real use they crowded out implementation code without helping the agent.
    const rankedReverse = reverse.edges
      .map(edge => ({ edge, taskScore: lexicalEdgeScore(edge.target.name, edge.target.file, edge.site, terms), prior: edgePrior[edge.kind] }))
      .sort((a, b) => b.taskScore - a.taskScore || b.prior - a.prior || a.edge.target.id.localeCompare(b.edge.target.id))
      .map(item => item.edge);
    // A type-level lead (a status-code union, an options interface) can be used all over the repository;
    // its users are mostly unrelated to the task, so only the few most task-related are kept, and no tests.
    // Same for a hub: a lead used from dozens of places (a context getter, a shared helper) brings callers
    // that have nothing to do with the task.
    const typeLead = lead.typeLevel === true || reverse.edges.length > hubCallers;
    let testsKept = 0;
    const reverseEdges = rankedReverse
      .filter(edge => edge.kind !== 'test' || (!typeLead && testsKept < maxTestCallersPerLead && testsKeptTotal < maxTestCallersTotal && (++testsKept, ++testsKeptTotal, true)))
      .slice(0, typeLead ? Math.max(0, Math.min(reverseFanIn, maxTypeLeadUsers - typeUsersKept)) : reverseFanIn);
    if (typeLead) typeUsersKept += reverseEdges.length;
    reversePruned += rankedReverse.length - reverseEdges.length;

    // Helpers declared inside the lead are part of its own body: returned with it, or noise when the lead
    // itself is cut to a signature.
    const insideLead = (target: CodeNode) => target.file === node.file && target.startLine >= node.startLine && target.endLine <= node.endLine;
    // Siblings: what the lead's same-file callers call alongside it. A caller that uses the lead together
    // with other local helpers (splitSource calling textUnits and sourceText) usually needs them changed
    // together; this is the one bounded two-hop step, kept to the lead's file.
    const siblingEdges: Dependency[] = [];
    const seenSiblings = new Set([node.id]);
    for (const caller of reverseEdges) {
      if (caller.kind !== 'caller' || caller.target.file !== node.file || siblingEdges.length >= maxSiblingsPerLead) continue;
      for (const next of adapter.dependencies(caller.target).edges) {
        if (siblingEdges.length >= maxSiblingsPerLead) break;
        if (!['call', 'method', 'import'].includes(next.kind) || next.target.file !== node.file || seenSiblings.has(next.target.id) || insideLead(next.target)) continue;
        seenSiblings.add(next.target.id);
        siblingEdges.push({ ...next, kind: 'sibling' });
      }
    }
    const candidates = [...forward.edges.filter(edge => !insideLead(edge.target)), ...reverseEdges, ...siblingEdges].map(edge => ({
      item: {
        node: edge.target,
        depth: (edge.kind === 'sibling' ? 2 : 1) as 1 | 2,
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
      const cost = capCost(leadTokens, item, perLeadTokenBudget);
      if (leadNodes >= perLeadNodeLimit || cost === undefined) {
        perLeadPruned++;
        continue;
      }
      merge(cappedCompiler, item);
      leadTokens += cost;
      leadNodes++;
    }
  }

  if (!semanticLeads.length) {
    return { task, status: 'incomplete', discovery, warnings: [...warnings, 'No semantic lead could be resolved by the compiler'] };
  }

  const rawCompilerItems = [...rawCompiler.values()];
  const rawTokens = rawCompilerItems.reduce((sum, item) => sum + item.estimatedTokens, 0);
  let compilerItems = [...cappedCompiler.values()].sort((a, b) =>
    b.structuralScore - a.structuralScore || a.depth - b.depth || a.node.id.localeCompare(b.node.id));
  const beforeTotalCap = compilerItems.length;
  let cappedTokens = 0;
  compilerItems = compilerItems.filter(item => {
    const cost = capCost(cappedTokens, item, neighborhoodTokenBudget);
    if (cost === undefined) return false;
    cappedTokens += cost;
    return true;
  });
  const totalPruned = beforeTotalCap - compilerItems.length;
  if (perLeadPruned) notes.push(`${perLeadPruned} per-lead compiler candidates were pruned by node/token bounds`);
  if (totalPruned) notes.push(`${totalPruned} merged compiler candidates were pruned by neighborhoodTokenBudget=${neighborhoodTokenBudget}`);
  if (reversePruned) notes.push(`${reversePruned} reverse caller/test edges were pruned by reverseFanIn=${reverseFanIn}`);

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
      let judged: JudgeCallResult | undefined;
      try {
        judged = contextJudge.rankContext
          ? await contextJudge.rankContext(task, judgeCandidates, options.signal)
          : contextJudge.judgeWithStats
            ? await contextJudge.judgeWithStats(task, syntheticEntry, judgeCandidates, options.signal)
            : { decisions: await contextJudge.judge(task, syntheticEntry, judgeCandidates, options.signal), stats: { batches: [] } };
      } catch (error) {
        // Stage 4 only reorders an already-recovered pool; if it fails, the structural order still stands.
        if (options.signal?.aborted) throw error;
        warnings.push(`Context ranking failed (${error instanceof Error ? error.message : String(error)}); structural order was used`);
      }
      contextRankingLatencyMs = performance.now() - contextStarted;

      if (judged) {
        contextJudgeStats = judged.stats;
        let undecided = 0;
        for (const item of rankingItems) {
          const semantic = judged.decisions.get(item.node.id)?.score;
          if (semantic === undefined) {
            // A missing answer is not evidence of irrelevance: keep the structural score alone.
            undecided++;
            item.finalScore = item.structuralScore;
            continue;
          }
          item.semanticScore = semantic;
          item.finalScore = 0.7 * semantic + 0.3 * item.structuralScore;
        }
        // A judge that scored nothing (e.g. the offline include-all judge) did not rank anything.
        contextRankingApplied = undecided < rankingItems.length;
        if (undecided && contextRankingApplied) warnings.push(`${undecided} context-ranking answers were missing or invalid; those candidates kept their structural score`);
      }
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

  // Budget allocation with a signature level. Pass 1 walks the ranking: a body when it fits, otherwise
  // the signature, otherwise omitted. Pass 2 spends what is left upgrading signatures back to bodies in
  // ranking order. (Starting large bodies at signature was tried and dropped: it demoted large owners
  // such as jevgrep's selectFile that the task needs in full.)
  //
  // Nested declarations overlap: a class body already contains its methods, a method its inner helpers.
  // Returning both sent the same lines twice and spent the budget on duplicates, so an item inside a
  // returned body is skipped as covered, and an item that would wrap a returned body is given as a signature.
  const levels = new Map<NeighborhoodItem, 'body' | 'signature'>();
  const covered = new Set<NeighborhoodItem>();
  const bodies: NeighborhoodItem[] = [];
  const contains = (outer: NeighborhoodItem, inner: NeighborhoodItem) => outer !== inner && outer.node.file === inner.node.file
    && outer.node.startLine <= inner.node.startLine && outer.node.endLine >= inner.node.endLine;
  let usedTokens = 0;
  // A large class reached from a lead (constructed or used as a type) is given as its member outline:
  // the agent needs its API, not hundreds of lines of unrelated methods. Leads keep their bodies.
  const outlineOnly = (item: NeighborhoodItem) => item.depth === 1 && item.node.outline === true && item.estimatedTokens > largeClassTokens;
  for (const item of rankingItems) {
    if (bodies.some(body => contains(body, item))) { covered.add(item); continue; }
    const signatureCost = signatureTokens(item.node);
    if (outlineOnly(item)) {
      if (usedTokens + signatureCost <= tokenBudget) { levels.set(item, 'signature'); usedTokens += signatureCost; }
      continue;
    }
    // An item that encloses bodies already returned (a function around its own inner helpers) replaces
    // them when it fits: its body includes theirs, so their tokens are refunded instead of duplicated.
    const inner = bodies.filter(body => contains(item, body));
    const refund = inner.reduce((sum, body) => sum + body.estimatedTokens, 0);
    if (!item.node.external && usedTokens - refund + item.estimatedTokens <= tokenBudget) {
      for (const body of inner) { levels.delete(body); covered.add(body); bodies.splice(bodies.indexOf(body), 1); }
      levels.set(item, 'body');
      bodies.push(item);
      usedTokens += item.estimatedTokens - refund;
    } else if (usedTokens + signatureCost <= tokenBudget) {
      levels.set(item, 'signature');
      usedTokens += signatureCost;
    }
  }
  for (const item of rankingItems) {
    if (levels.get(item) !== 'signature' || item.node.external || outlineOnly(item) || bodies.some(body => contains(item, body) || contains(body, item))) continue;
    const extra = item.estimatedTokens - signatureTokens(item.node);
    if (usedTokens + extra <= tokenBudget) {
      levels.set(item, 'body');
      bodies.push(item);
      usedTokens += extra;
    }
  }
  const selected = rankingItems.filter(item => levels.has(item));
  const omittedPool = rankingItems.filter(item => !levels.has(item) && !covered.has(item));
  if (covered.size) notes.push(`${covered.size} candidates were already inside other returned code`);
  const downgraded = selected.filter(item => levels.get(item) === 'signature' && !item.node.external).length;
  if (downgraded) notes.push(`${downgraded} ranking-pool candidates were reduced to signatures by final tokenBudget=${tokenBudget}`);
  if (omittedPool.length) notes.push(`${omittedPool.length} ranking-pool candidates were omitted by final tokenBudget=${tokenBudget}`);

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
  const items = selected.map(item => toContextItem(item, levels.get(item)!));
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

  if (unresolved.length) notes.push(`${unresolved.length} dynamic or external references were not followed (static analysis limit)`);

  return {
    task,
    judge: contextRankingApplied ? contextJudge.name : 'structural-budget',
    status: warnings.length ? 'incomplete' : 'complete',
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
    notes,
    discovery,
    semanticLeads,
    neighborhood: { items: compilerItems, stats: neighborhoodStats },
    rankingPool: { items: rankingItems, stats: rankingPoolStats },
    contextRankingApplied,
    contextRankingLatencyMs,
    contextJudgeStats,
  };
}
