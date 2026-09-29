import { performance } from 'node:perf_hooks';
import { retrieve, type RetrievalOptions, type RetrievalResult } from './retrieve.js';
import type { EntryInput, LanguageAdapter, RelevanceJudge } from './types.js';
import type { DiscoveryResult, EntryLead } from './discovery.js';
import type { TaskPipelineResult } from './task-pipeline.js';

/** Entry gold uses locations, so aliases and qualified display names do not affect hits. */
export function scoreDiscovery(result: DiscoveryResult, acceptableEntries: EntryInput[]) {
  const matches = (lead: { file: string; line: number; endLine: number }) => acceptableEntries.some(entry =>
    lead.file === entry.file && entry.line !== undefined && lead.line <= entry.line && lead.endLine >= (entry.endLine ?? entry.line));
  return {
    selectedHit: result.selected ? matches(result.selected) : false,
    hitAt1: result.leads.slice(0, 1).some(matches),
    hitAt3: result.leads.slice(0, 3).some(matches),
    hitAt5: result.leads.slice(0, 5).some(matches),
    shortlistHit: result.leads.some(matches),
  };
}

/** A minimum-required set cannot establish precision. Include the entry for task-level recall. */
export function scoreRequiredContext(result: Pick<RetrievalResult, 'items'> | undefined, targets: GoldTarget[]) {
  const items = result?.items ?? [];
  const hit = (target: GoldTarget, requireLevel: boolean) => items.some(item =>
    item.node.file === target.file && (target.line !== undefined
      ? item.node.startLine <= target.line && item.node.endLine >= target.line
      : item.node.name === target.name)
    && (!requireLevel || levelSatisfies(item.level, target.requiredLevel ?? 'body')));
  return {
    requiredTargets: targets.length,
    recall: ratio(targets.filter(target => hit(target, false)).length, targets.length),
    requiredLevelRecall: ratio(targets.filter(target => hit(target, true)).length, targets.length),
    missing: targets.filter(target => !hit(target, true)),
  };
}

/** Minimum-required labels do not define true precision; density is only a lower-bound style compactness signal. */
export function scoreContextFootprint(result: Pick<RetrievalResult, 'items' | 'usedTokens'> | undefined, targets: GoldTarget[]) {
  const items = result?.items ?? [];
  const matches = (target: GoldTarget) => items.some(item =>
    item.node.file === target.file && (target.line !== undefined
      ? item.node.startLine <= target.line && item.node.endLine >= target.line
      : item.node.name === target.name));
  const requiredIncluded = targets.filter(matches).length;
  return {
    includedSymbols: items.length,
    includedFiles: new Set(items.map(item => item.node.file)).size,
    bodySymbols: items.filter(item => item.level === 'body').length,
    signatureSymbols: items.filter(item => item.level === 'signature').length,
    usedTokens: result?.usedTokens ?? 0,
    requiredIncluded,
    minimumRequiredDensity: items.length === 0 ? 0 : requiredIncluded / items.length,
  };
}

/** Distance is measured on the actual returned compiler path from the selected lead. */
export function scoreLeadRecovery(result: Pick<RetrievalResult, 'items'> | undefined, acceptableEntries: EntryInput[]) {
  const items = result?.items ?? [];
  const depths = items.flatMap(item => acceptableEntries.some(entry =>
    item.node.file === entry.file && entry.line !== undefined
      && item.node.startLine <= entry.line && item.node.endLine >= (entry.endLine ?? entry.line)) ? [item.depth] : []);
  const canonicalEntryDepth = depths.length ? Math.min(...depths) : undefined;
  return {
    canonicalEntryDepth,
    canonicalWithin1: canonicalEntryDepth !== undefined && canonicalEntryDepth <= 1,
    canonicalWithin2: canonicalEntryDepth !== undefined && canonicalEntryDepth <= 2,
  };
}

function targetMatchesNode(target: GoldTarget, node: { file: string; name: string; startLine: number; endLine?: number }): boolean {
  return node.file === target.file && (target.line !== undefined
    ? node.startLine <= target.line && (node.endLine ?? node.startLine) >= target.line
    : node.name === target.name);
}

export function scoreCandidatePoolRecall(adapter: LanguageAdapter, candidates: EntryLead[], targets: GoldTarget[]) {
  const candidateIds = new Set<string>();
  for (const lead of candidates) {
    try { candidateIds.add(adapter.findEntry({ file: lead.file, line: lead.line, endLine: lead.endLine, symbol: lead.name }).id); } catch { /* benchmark reports misses below */ }
  }
  let strictHits = 0;
  let softHits = 0;
  const strictMissed: GoldTarget[] = [];
  const softMissed: GoldTarget[] = [];
  for (const target of targets) {
    try {
      const node = adapter.findEntry({ file: target.file, line: target.line, symbol: target.line ? undefined : target.name });
      const strict = candidateIds.has(node.id);
      const neighborhood = new Set([node.id, ...adapter.dependencies(node).edges.map(edge => edge.target.id), ...adapter.reverseDependencies(node).edges.map(edge => edge.target.id)]);
      const soft = [...neighborhood].some(id => candidateIds.has(id));
      if (strict) strictHits++; else strictMissed.push(target);
      if (soft) softHits++; else softMissed.push(target);
    } catch {
      strictMissed.push(target);
      softMissed.push(target);
    }
  }
  return {
    candidates: candidates.length,
    requiredTargets: targets.length,
    strictRecallAt64: ratio(strictHits, targets.length),
    softRecallAt64: ratio(softHits, targets.length),
    strictHits,
    softHits,
    strictMissed,
    softMissed,
  };
}

export function scoreSemanticLeadDistance(adapter: LanguageAdapter, leads: EntryLead[], targets: GoldTarget[], maxHops = 2) {
  const targetNodes = targets.flatMap(target => {
    try { return [adapter.findEntry({ file: target.file, line: target.line, symbol: target.line ? undefined : target.name })]; } catch { return []; }
  });
  const targetIds = new Set(targetNodes.map(node => node.id));
  const distances = leads.map(lead => {
    try {
      const start = adapter.findEntry({ file: lead.file, line: lead.line, endLine: lead.endLine, symbol: lead.name });
      if (targetIds.has(start.id)) return 0;
      let frontier = [start];
      const seen = new Set([start.id]);
      for (let depth = 1; depth <= maxHops; depth++) {
        const next: typeof frontier = [];
        for (const node of frontier) {
          const edges = [...adapter.dependencies(node).edges, ...adapter.reverseDependencies(node).edges];
          for (const edge of edges) {
            if (seen.has(edge.target.id)) continue;
            if (targetIds.has(edge.target.id)) return depth;
            seen.add(edge.target.id);
            if (seen.size < 256) next.push(edge.target);
          }
        }
        frontier = next;
      }
    } catch { /* unresolved lead remains undefined */ }
    return undefined;
  });
  return {
    leads: leads.length,
    distances,
    within1: ratio(distances.filter(distance => distance !== undefined && distance <= 1).length, leads.length),
    within2: ratio(distances.filter(distance => distance !== undefined && distance <= 2).length, leads.length),
  };
}

export function scoreNeighborhoodStage(result: TaskPipelineResult | undefined, targets: GoldTarget[]) {
  const neighborhood = result?.neighborhood.items ?? [];
  const hits = targets.filter(target => neighborhood.some(item => targetMatchesNode(target, item.node))).length;
  return {
    recall: ratio(hits, targets.length),
    requiredTargets: targets.length,
    hits,
    symbols: neighborhood.length,
    tokens: result?.neighborhood.stats.cappedTokens ?? 0,
    rawSymbols: result?.neighborhood.stats.rawSymbols ?? 0,
    rawTokens: result?.neighborhood.stats.rawTokens ?? 0,
  };
}

export type RequiredContextLevel = 'signature' | 'body';

export interface GoldTarget {
  file: string;
  name: string;
  line?: number;
  requiredLevel?: RequiredContextLevel;
}

export interface EvaluationCase {
  id: string;
  task: string;
  entry: EntryInput;
  gold: GoldTarget[];
}

export interface RetrievalMetrics {
  goldCount: number;
  retrievedCount: number;
  relevantRetrieved: number;
  precision: number;
  recall: number;
  bodyRecall: number;
  requiredLevelRecall: number;
  relevantPer1kTokens: number;
  omittedRelevant: number;
  usedTokens: number;
  considered: number;
  unresolved: number;
  latencyMs: number;
}

export interface EvaluationRun {
  caseId: string;
  method: string;
  result: RetrievalResult;
  metrics: RetrievalMetrics;
}

function matchesTarget(
  node: { file: string; name: string; startLine: number },
  target: GoldTarget,
): boolean {
  return node.file === target.file
    && node.name === target.name
    && (target.line === undefined || node.startLine === target.line);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function levelSatisfies(actual: 'body' | 'signature' | 'omitted', required: RequiredContextLevel): boolean {
  if (actual === 'body') return true;
  return required === 'signature' && actual === 'signature';
}

/**
 * Score one retrieval result against manually labeled dependency targets.
 *
 * The entry declaration is excluded from retrieval precision/recall. Gold targets
 * should therefore contain only code that the agent needs in addition to the entry.
 */
export function scoreRetrieval(
  result: RetrievalResult,
  gold: GoldTarget[],
  latencyMs = 0,
): RetrievalMetrics {
  const retrieved = result.items.filter(item => item.depth > 0);
  const relevantItems = retrieved.filter(item => gold.some(target => matchesTarget(item.node, target)));
  const hitTargets = gold.filter(target => relevantItems.some(item => matchesTarget(item.node, target)));
  const bodyHits = gold.filter(target => relevantItems.some(item => matchesTarget(item.node, target) && item.level === 'body'));
  const levelHits = gold.filter(target => {
    const required = target.requiredLevel ?? 'signature';
    return relevantItems.some(item => matchesTarget(item.node, target) && levelSatisfies(item.level, required));
  });
  const omittedRelevant = gold.filter(target =>
    result.omitted.some(item => matchesTarget(item.node, target)),
  ).length;

  return {
    goldCount: gold.length,
    retrievedCount: retrieved.length,
    relevantRetrieved: relevantItems.length,
    precision: retrieved.length === 0 ? (gold.length === 0 ? 1 : 0) : relevantItems.length / retrieved.length,
    recall: ratio(hitTargets.length, gold.length),
    bodyRecall: ratio(bodyHits.length, gold.length),
    requiredLevelRecall: ratio(levelHits.length, gold.length),
    relevantPer1kTokens: result.usedTokens === 0 ? 0 : (relevantItems.length * 1000) / result.usedTokens,
    omittedRelevant,
    usedTokens: result.usedTokens,
    considered: result.considered,
    unresolved: result.unresolved.length,
    latencyMs,
  };
}

export async function evaluateCase(
  adapter: LanguageAdapter,
  judge: RelevanceJudge,
  benchmarkCase: EvaluationCase,
  options: RetrievalOptions = {},
  method = judge.name,
): Promise<EvaluationRun> {
  const started = performance.now();
  const result = await retrieve(
    adapter,
    judge,
    benchmarkCase.task,
    benchmarkCase.entry,
    options,
  );
  const latencyMs = performance.now() - started;

  return {
    caseId: benchmarkCase.id,
    method,
    result,
    metrics: scoreRetrieval(result, benchmarkCase.gold, latencyMs),
  };
}

export interface AggregateMetrics {
  cases: number;
  meanPrecision: number;
  meanRecall: number;
  meanBodyRecall: number;
  meanRequiredLevelRecall: number;
  meanRelevantPer1kTokens: number;
  meanUsedTokens: number;
  meanLatencyMs: number;
  totalUnresolved: number;
  totalOmittedRelevant: number;
}

export function aggregateRuns(runs: EvaluationRun[]): AggregateMetrics {
  const mean = (pick: (run: EvaluationRun) => number): number =>
    runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + pick(run), 0) / runs.length;

  return {
    cases: runs.length,
    meanPrecision: mean(run => run.metrics.precision),
    meanRecall: mean(run => run.metrics.recall),
    meanBodyRecall: mean(run => run.metrics.bodyRecall),
    meanRequiredLevelRecall: mean(run => run.metrics.requiredLevelRecall),
    meanRelevantPer1kTokens: mean(run => run.metrics.relevantPer1kTokens),
    meanUsedTokens: mean(run => run.metrics.usedTokens),
    meanLatencyMs: mean(run => run.metrics.latencyMs),
    totalUnresolved: runs.reduce((sum, run) => sum + run.metrics.unresolved, 0),
    totalOmittedRelevant: runs.reduce((sum, run) => sum + run.metrics.omittedRelevant, 0),
  };
}
