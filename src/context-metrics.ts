import type { DiscoveryResult } from './discovery.js';
import type { RetrievalResult } from './retrieve.js';
import type { TaskPipelineResult } from './task-pipeline.js';

export interface RetrievalLatencyStats {
  medianMs: number;
  p95Ms: number;
  sampleCount: number;
  windowSize: number;
}

export class RetrievalLatencyWindow {
  private readonly samples: number[] = [];

  constructor(readonly windowSize = 50) {
    if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('Latency windowSize must be a positive integer');
  }

  record(valueMs: number): RetrievalLatencyStats {
    if (!Number.isFinite(valueMs) || valueMs < 0) throw new Error('Latency sample must be a non-negative finite number');
    this.samples.push(valueMs);
    if (this.samples.length > this.windowSize) this.samples.splice(0, this.samples.length - this.windowSize);
    return this.snapshot();
  }

  snapshot(): RetrievalLatencyStats {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sampleCount = sorted.length;
    if (!sampleCount) return { medianMs: 0, p95Ms: 0, sampleCount: 0, windowSize: this.windowSize };
    const middle = Math.floor(sampleCount / 2);
    const medianMs = sampleCount % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    const p95Index = Math.max(0, Math.ceil(sampleCount * 0.95) - 1);
    return { medianMs, p95Ms: sorted[p95Index], sampleCount, windowSize: this.windowSize };
  }
}

export interface SessionSavingsStats {
  retrievals: number;
  candidateTokens: number;
  returnedTokens: number;
  /** Left out of JevTrace's own candidate pool: not reading the agent was spared, which it cannot see. */
  savedTokens: number;
  reductionPercent: number;
  /** The returned code's files read whole: the comparison an agent can act on. */
  fileTokens: number;
}

/** Running totals over every task-only retrieval since the server started (in memory, reset on restart). */
export class SessionSavings {
  private stats: SessionSavingsStats = { retrievals: 0, candidateTokens: 0, returnedTokens: 0, savedTokens: 0, reductionPercent: 0, fileTokens: 0 };

  /** `fileTokens`: the returned code's files read whole, when known. */
  record(candidateTokens: number, returnedTokens: number, fileTokens = 0): SessionSavingsStats {
    const retrievals = this.stats.retrievals + 1;
    const candidate = this.stats.candidateTokens + candidateTokens;
    const returned = this.stats.returnedTokens + returnedTokens;
    const saved = this.stats.savedTokens + Math.max(0, candidateTokens - returnedTokens);
    this.stats = { retrievals, candidateTokens: candidate, returnedTokens: returned, savedTokens: saved, reductionPercent: candidate ? saved / candidate : 0,
      fileTokens: this.stats.fileTokens + fileTokens };
    return this.snapshot();
  }

  snapshot(): SessionSavingsStats {
    return { ...this.stats };
  }
}

export interface ContextSavingsSummary {
  estimated: true;
  basis: 'ranking-pool' | 'explicit-entry';
  available: boolean;
  candidateTokens?: number;
  returnedTokens: number;
  savedTokens?: number;
  reductionPercent?: number;
  tokenBudget: number;
  budgetUtilization: number;
  candidateSymbols?: number;
  returnedSymbols: number;
  omittedSymbols: number;
  /** Repository files the returned code comes from, and their size read whole (the comparison an agent can act on). */
  files?: number;
  fileTokens?: number;
  rawNeighborhoodTokens?: number;
  cappedNeighborhoodTokens?: number;
  semanticLeads?: number;
  stage4Applied?: boolean;
  providerRequests: number;
  discoveryMs?: number;
  stage4Ms?: number;
  totalMs: number;
  latencyStats?: RetrievalLatencyStats;
  /** Totals since the server started, including this retrieval. */
  session?: SessionSavingsStats;
  status: 'complete' | 'incomplete';
  warningCount: number;
}

type QuerySuccess = RetrievalResult & {
  discovery?: DiscoveryResult;
  rankingPool?: TaskPipelineResult['rankingPool'];
  neighborhood?: TaskPipelineResult['neighborhood'];
  semanticLeads?: TaskPipelineResult['semanticLeads'];
  contextRankingApplied?: boolean;
  contextRankingLatencyMs?: number;
};

const attempts = (result: QuerySuccess): number => {
  const traversalRequests = result.judgeTrace.reduce((sum, trace) => sum + trace.providerRequests, 0);
  const discoveryRequests = result.discovery?.judgeStats.batches.reduce((sum, batch) => sum + batch.attempts, 0) ?? 0;
  return traversalRequests + discoveryRequests;
};

export function summarizeContextSavings(result: QuerySuccess, totalMs: number, latencyStats?: RetrievalLatencyStats, session?: SessionSavings,
  fileTokens?: (file: string) => number | undefined): ContextSavingsSummary {
  const candidateTokens = result.rankingPool?.stats.tokens;
  const files = [...new Set(result.items.filter(item => !item.node.external).map(item => item.node.file))];
  const sizes = fileTokens ? files.map(fileTokens) : [];
  const wholeFiles = sizes.length && sizes.every(size => size !== undefined) ? sizes.reduce((sum, size) => sum! + size!, 0) : undefined;
  const savedTokens = candidateTokens === undefined ? undefined : Math.max(0, candidateTokens - result.usedTokens);
  const reductionPercent = candidateTokens && savedTokens !== undefined ? savedTokens / candidateTokens : undefined;

  return {
    estimated: true,
    basis: candidateTokens === undefined ? 'explicit-entry' : 'ranking-pool',
    available: candidateTokens !== undefined,
    candidateTokens,
    returnedTokens: result.usedTokens,
    savedTokens,
    reductionPercent,
    tokenBudget: result.tokenBudget,
    budgetUtilization: result.tokenBudget > 0 ? result.usedTokens / result.tokenBudget : 0,
    candidateSymbols: result.rankingPool?.stats.symbols,
    returnedSymbols: result.items.length,
    omittedSymbols: result.omitted.length,
    files: files.length,
    fileTokens: wholeFiles,
    rawNeighborhoodTokens: result.neighborhood?.stats.rawTokens,
    cappedNeighborhoodTokens: result.neighborhood?.stats.cappedTokens,
    semanticLeads: result.semanticLeads?.length,
    stage4Applied: result.contextRankingApplied,
    providerRequests: attempts(result),
    discoveryMs: result.discovery?.latencyMs,
    stage4Ms: result.contextRankingLatencyMs,
    totalMs,
    latencyStats,
    session: session && candidateTokens !== undefined ? session.record(candidateTokens, result.usedTokens, wholeFiles) : session?.snapshot(),
    status: result.status,
    warningCount: result.warnings.length,
  };
}

/**
 * One line for the agent: what came back, against the files it comes from read whole, which is what the agent
 * would otherwise open. The ranking-pool reduction stays in the dashboard; measured against JevTrace's own
 * candidate pool, it said nothing about the reading the agent was spared.
 */
export function formatContextSavings(summary: ContextSavingsSummary): string {
  const returned = `Estimated context: ~${summary.returnedTokens.toLocaleString()} tokens of code`;
  if (!summary.files) return `${returned}.`;
  const fileCount = `${summary.files.toLocaleString()} file${summary.files === 1 ? '' : 's'}`;
  return summary.fileTokens === undefined
    ? `${returned} from ${fileCount}.`
    : `${returned} from ${fileCount} (those files read whole: ~${summary.fileTokens.toLocaleString()} tokens).`;
}
