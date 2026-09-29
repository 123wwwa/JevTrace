import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { OpenRouterJevJudge } from '../dist/judges.js';
import { aggregateRuns, evaluateCase } from '../dist/evaluate.js';
import { benchmarkCases } from './benchmark-cases.mjs';

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY is required for batch-size sweep');
}

const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const repetitions = Number(argument('--runs') ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error('--runs must be an integer between 1 and 10');
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const batchSizes = [1, 2, 4, 8, 16];
const model = process.env.JEVTRACE_OPENROUTER_JEV_MODEL ?? 'typesafe/jev-1.13';
const fixed = {
  reverse: false,
  tokenBudget: 2000,
  maxNodes: 30,
  maxDepth: 2,
  wrapperLookahead: true,
  visitPolicy: 'score',
  bodyThreshold: 0.3,
  omitThreshold: 0.3,
};

const adapters = new Map(batchSizes.map(size => [size, new TypeScriptAdapter(root)]));
for (const adapter of adapters.values()) {
  adapter.findEntry(benchmarkCases[0].entry);
}

const bySize = new Map(batchSizes.map(size => [size, []]));

for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const [caseIndex, benchmarkCase] of benchmarkCases.entries()) {
    const order = caseIndex % 2 === 0 ? batchSizes : [...batchSizes].reverse();

    for (const batchSize of order) {
      const judge = new OpenRouterJevJudge(process.env.OPENROUTER_API_KEY, model, batchSize);
      const run = await evaluateCase(
        adapters.get(batchSize),
        judge,
        benchmarkCase,
        fixed,
        `jev-batch-${batchSize}`,
      );
      bySize.get(batchSize).push(run);
      process.stdout.write(
        `run ${repetition}/${repetitions} | ${benchmarkCase.id} | batch=${batchSize} | ${run.metrics.latencyMs.toFixed(0)}ms\n`,
      );
    }
  }
}

const mean = values => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
};
const percent = value => (value * 100).toFixed(1) + '%';
const number = value => Number(value.toFixed(2));

const rows = batchSizes.map(batchSize => {
  const runs = bySize.get(batchSize);
  const metrics = aggregateRuns(runs);
  const traces = runs.flatMap(run => run.result.judgeTrace);
  const roundLatencies = traces.map(trace => trace.latencyMs);
  const batchLatencies = traces.flatMap(trace => trace.batchLatenciesMs);

  return {
    batchSize,
    cases: runs.length,
    precision: metrics.meanPrecision,
    recall: metrics.meanRecall,
    requiredRecall: metrics.meanRequiredLevelRecall,
    avgTokens: metrics.meanUsedTokens,
    avgCaseLatencyMs: metrics.meanLatencyMs,
    medianRoundMs: percentile(roundLatencies, 0.5),
    p95RoundMs: percentile(roundLatencies, 0.95),
    maxRoundMs: Math.max(...roundLatencies),
    medianProviderBatchMs: percentile(batchLatencies, 0.5),
    p95ProviderBatchMs: percentile(batchLatencies, 0.95),
    providerRequests: traces.reduce((sum, trace) => sum + trace.providerRequests, 0),
    totalPayloadBytes: traces.reduce((sum, trace) => sum + trace.payloadBytes, 0),
    avgBatchesPerRound: mean(traces.map(trace => trace.providerBatches)),
  };
});

console.log(`\nJevTrace provider batch-size sweep — ${repetitions} run(s) × ${benchmarkCases.length} cases\n`);
console.table(rows.map(row => ({
  batchSize: row.batchSize,
  cases: row.cases,
  precision: percent(row.precision),
  recall: percent(row.recall),
  requiredRecall: percent(row.requiredRecall),
  avgTokens: number(row.avgTokens),
  avgCaseMs: number(row.avgCaseLatencyMs),
  medianRoundMs: number(row.medianRoundMs),
  p95RoundMs: number(row.p95RoundMs),
  maxRoundMs: number(row.maxRoundMs),
  medianBatchMs: number(row.medianProviderBatchMs),
  p95BatchMs: number(row.p95ProviderBatchMs),
  providerRequests: row.providerRequests,
  payloadKB: number(row.totalPayloadBytes / 1024),
  avgBatchesPerRound: number(row.avgBatchesPerRound),
})));

const worstRounds = [];
for (const batchSize of batchSizes) {
  for (const run of bySize.get(batchSize)) {
    for (const trace of run.result.judgeTrace) {
      worstRounds.push({
        batchSize,
        case: run.caseId,
        round: trace.round,
        depth: trace.depth,
        candidates: trace.candidates,
        payloadBytes: trace.payloadBytes,
        providerBatches: trace.providerBatches,
        providerRequests: trace.providerRequests,
        batchSizes: trace.batchSizes.join(','),
        latencyMs: trace.latencyMs,
      });
    }
  }
}

worstRounds.sort((a, b) => b.latencyMs - a.latencyMs);
console.log('\nSlowest relevance rounds');
console.table(worstRounds.slice(0, 15).map(row => ({
  ...row,
  latencyMs: number(row.latencyMs),
})));
