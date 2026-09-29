import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge, OpenRouterJevJudge } from '../dist/judges.js';
import { aggregateRuns, evaluateCase } from '../dist/evaluate.js';
import { benchmarkCases } from './benchmark-cases.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const withJev = Boolean(process.env.OPENROUTER_API_KEY);
const withChoice = process.argv.includes('--choice');
const verbose = process.argv.includes('--verbose');
const roundDetails = process.argv.includes('--rounds');
const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const bodyThreshold = Number(argument('--body-threshold') ?? 0.3);
const omitThreshold = Number(argument('--omit-threshold') ?? 0.3);

const fixed = {
  reverse: false,
  tokenBudget: 2000,
  maxNodes: 30,
  maxDepth: 2,
  wrapperLookahead: true,
  bodyThreshold,
  omitThreshold,
};

const key = value => `${value.file}::${value.name}`;
const makeOracleJudge = benchmarkCase => {
  const relevant = new Set(benchmarkCase.gold.map(key));
  return {
    name: 'oracle-filter',
    async judge(_task, _entry, candidates) {
      return new Map(candidates.map(candidate => {
        const include = relevant.has(key(candidate.node));
        return [candidate.node.id, { include, score: include ? 0.9 : 0.1 }];
      }));
    },
  };
};

const adapters = {
  'entry-only': new TypeScriptAdapter(root),
  'static-all': new TypeScriptAdapter(root),
  'oracle-filter': new TypeScriptAdapter(root),
  'jev-score': new TypeScriptAdapter(root),
  'jev-choice': new TypeScriptAdapter(root),
};

for (const adapter of Object.values(adapters)) {
  adapter.findEntry(benchmarkCases[0].entry);
}

const jevJudge = withJev ? new OpenRouterJevJudge(process.env.OPENROUTER_API_KEY) : undefined;
const allRuns = [];

for (const benchmarkCase of benchmarkCases) {
  allRuns.push(await evaluateCase(
    adapters['entry-only'],
    new IncludeAllJudge(),
    benchmarkCase,
    { ...fixed, maxDepth: 0 },
    'entry-only',
  ));

  allRuns.push(await evaluateCase(
    adapters['static-all'],
    new IncludeAllJudge(),
    benchmarkCase,
    fixed,
    'static-all',
  ));

  allRuns.push(await evaluateCase(
    adapters['oracle-filter'],
    makeOracleJudge(benchmarkCase),
    benchmarkCase,
    fixed,
    'oracle-filter',
  ));

  if (jevJudge) {
    allRuns.push(await evaluateCase(
      adapters['jev-score'],
      jevJudge,
      benchmarkCase,
      { ...fixed, visitPolicy: 'score' },
      'jev-score',
    ));

    if (withChoice) {
      allRuns.push(await evaluateCase(
        adapters['jev-choice'],
        jevJudge,
        benchmarkCase,
        { ...fixed, visitPolicy: 'choice' },
        'jev-choice',
      ));
    }
  }
}

if (!withJev) {
  process.stderr.write('OPENROUTER_API_KEY is not set; Jev methods were skipped.\n');
}

const percent = value => (value * 100).toFixed(1) + '%';
const number = value => Number(value.toFixed(2));

console.log(`\nJevTrace synthetic retrieval benchmark — ${benchmarkCases.length} cases (body>${bodyThreshold}, omit<${omitThreshold})\n`);
console.table(allRuns.map(run => ({
  case: run.caseId,
  method: run.method,
  recall: percent(run.metrics.recall),
  precision: percent(run.metrics.precision),
  requiredRecall: percent(run.metrics.requiredLevelRecall),
  tokens: run.metrics.usedTokens,
  relevantPer1k: number(run.metrics.relevantPer1kTokens),
  omittedGold: run.metrics.omittedRelevant,
  judgeRounds: run.result.judgeRounds,
  latencyMs: number(run.metrics.latencyMs),
})));

const methods = [...new Set(allRuns.map(run => run.method))];
const aggregates = methods.map(method => {
  const runs = allRuns.filter(run => run.method === method);
  const metrics = aggregateRuns(runs);
  return {
    method,
    cases: metrics.cases,
    precision: percent(metrics.meanPrecision),
    recall: percent(metrics.meanRecall),
    bodyRecall: percent(metrics.meanBodyRecall),
    requiredRecall: percent(metrics.meanRequiredLevelRecall),
    avgTokens: number(metrics.meanUsedTokens),
    relevantPer1k: number(metrics.meanRelevantPer1kTokens),
    avgLatencyMs: number(metrics.meanLatencyMs),
    avgJudgeRounds: number(runs.reduce((sum, run) => sum + run.result.judgeRounds, 0) / runs.length),
    omittedGold: metrics.totalOmittedRelevant,
    unresolved: metrics.totalUnresolved,
  };
});

console.log('\nAggregate (macro average across cases)');
console.table(aggregates);

const staticAggregate = aggregates.find(row => row.method === 'static-all');
for (const method of ['oracle-filter', 'jev-score', 'jev-choice']) {
  const row = aggregates.find(candidate => candidate.method === method);
  if (!row || !staticAggregate) continue;
  const tokenReduction = staticAggregate.avgTokens === 0
    ? 0
    : 1 - row.avgTokens / staticAggregate.avgTokens;
  console.log(
    `${method}: context ${percent(tokenReduction)} smaller than static-all; ` +
    `macro recall ${row.recall}; required-level recall ${row.requiredRecall}.`,
  );
}

if (roundDetails) {
  for (const run of allRuns.filter(run => run.method.startsWith('jev-'))) {
    console.log(`\n[${run.caseId} / ${run.method} / round details]`);
    console.table(run.result.judgeTrace.map(trace => ({
      round: trace.round,
      depth: trace.depth,
      candidates: trace.candidates,
      payloadBytes: trace.payloadBytes,
      providerBatches: trace.providerBatches,
      providerRequests: trace.providerRequests,
      cacheHits: trace.cacheHits,
      batchSizes: trace.batchSizes.join(','),
      batchLatencyMs: trace.batchLatenciesMs.map(number).join(','),
      roundLatencyMs: number(trace.latencyMs),
    })));
  }
}

if (verbose) {
  for (const run of allRuns.filter(run => run.method.startsWith('jev-'))) {
    console.log(`\n[${run.caseId} / ${run.method}]`);
    const decisions = [
      ...run.result.items
        .filter(item => item.depth > 0)
        .map(item => ({
          symbol: `${item.node.file}::${item.node.name}`,
          level: item.level,
          score: item.score === undefined ? 'n/a' : item.score.toFixed(3),
        })),
      ...run.result.omitted.map(item => ({
        symbol: `${item.node.file}::${item.node.name}`,
        level: 'omitted',
        score: item.score === undefined ? 'n/a' : item.score.toFixed(3),
      })),
    ];
    console.table(decisions);
  }
}
