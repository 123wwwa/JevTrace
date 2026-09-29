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
  rawNeighborhoodTokens?: number;
  cappedNeighborhoodTokens?: number;
  semanticLeads?: number;
  stage4Applied?: boolean;
  providerRequests: number;
  discoveryMs?: number;
  stage4Ms?: number;
  totalMs: number;
  latencyStats?: RetrievalLatencyStats;
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

export function summarizeContextSavings(result: QuerySuccess, totalMs: number, latencyStats?: RetrievalLatencyStats): ContextSavingsSummary {
  const candidateTokens = result.rankingPool?.stats.tokens;
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
    rawNeighborhoodTokens: result.neighborhood?.stats.rawTokens,
    cappedNeighborhoodTokens: result.neighborhood?.stats.cappedTokens,
    semanticLeads: result.semanticLeads?.length,
    stage4Applied: result.contextRankingApplied,
    providerRequests: attempts(result),
    discoveryMs: result.discovery?.latencyMs,
    stage4Ms: result.contextRankingLatencyMs,
    totalMs,
    latencyStats,
    status: result.status,
    warningCount: result.warnings.length,
  };
}

export function formatContextSavings(summary: ContextSavingsSummary): string {
  if (!summary.available || summary.candidateTokens === undefined || summary.savedTokens === undefined || summary.reductionPercent === undefined) {
    return `Estimated returned context: ${summary.returnedTokens.toLocaleString()} tokens (explicit-entry path; no comparable ranking pool).`;
  }

  return `Estimated context: ${summary.candidateTokens.toLocaleString()} → ${summary.returnedTokens.toLocaleString()} tokens (${(summary.reductionPercent * 100).toFixed(1)}% reduction, ${summary.savedTokens.toLocaleString()} tokens excluded).`;
}
