import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { OpenRouterJevJudge } from '../dist/judges.js';
import { aggregateRuns, evaluateCase } from '../dist/evaluate.js';
import { benchmarkCases } from './benchmark-cases.mjs';

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY is required for threshold sweep');
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const omitThreshold = 0.3;
const judge = new OpenRouterJevJudge(process.env.OPENROUTER_API_KEY);
const adapter = new TypeScriptAdapter(root);

adapter.findEntry(benchmarkCases[0].entry);

const rows = [];

for (const bodyThreshold of thresholds) {
  const runs = [];

  for (const benchmarkCase of benchmarkCases) {
    runs.push(await evaluateCase(
      adapter,
      judge,
      benchmarkCase,
      {
        reverse: false,
        tokenBudget: 2000,
        maxNodes: 30,
        maxDepth: 2,
        wrapperLookahead: true,
        visitPolicy: 'score',
        bodyThreshold,
        omitThreshold,
      },
      `jev-body-${bodyThreshold.toFixed(1)}`,
    ));
  }

  const metrics = aggregateRuns(runs);
  rows.push({
    bodyThreshold,
    precision: metrics.meanPrecision,
    recall: metrics.meanRecall,
    bodyRecall: metrics.meanBodyRecall,
    requiredRecall: metrics.meanRequiredLevelRecall,
    avgTokens: metrics.meanUsedTokens,
    relevantPer1k: metrics.meanRelevantPer1kTokens,
    avgLatencyMs: metrics.meanLatencyMs,
    omittedGold: metrics.totalOmittedRelevant,
  });
}

const percent = value => (value * 100).toFixed(1) + '%';
const number = value => Number(value.toFixed(2));

console.log(`\nJevTrace body-threshold sweep — omit threshold fixed at ${omitThreshold}\n`);
console.table(rows.map(row => ({
  bodyThreshold: row.bodyThreshold.toFixed(1),
  precision: percent(row.precision),
  recall: percent(row.recall),
  bodyRecall: percent(row.bodyRecall),
  requiredRecall: percent(row.requiredRecall),
  avgTokens: number(row.avgTokens),
  relevantPer1k: number(row.relevantPer1k),
  avgLatencyMs: number(row.avgLatencyMs),
  omittedGold: row.omittedGold,
})));

const best = [...rows]
  .filter(row => row.requiredRecall >= 0.95)
  .sort((a, b) => a.avgTokens - b.avgTokens)[0];

if (best) {
  console.log(
    `Best threshold with >=95% required-level recall: body>${best.bodyThreshold.toFixed(1)} ` +
    `(${percent(best.requiredRecall)} required recall, ${number(best.avgTokens)} avg tokens).`,
  );
} else {
  console.log('No tested body threshold reached 95% required-level recall.');
}
