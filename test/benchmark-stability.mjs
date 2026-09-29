import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { OpenRouterJevJudge } from '../dist/judges.js';
import { retrieve } from '../dist/retrieve.js';
import { benchmarkCases } from './benchmark-cases.mjs';

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY is required for stability benchmark');
}

const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const repetitions = Number(argument('--runs') ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 20) {
  throw new Error('--runs must be an integer between 2 and 20');
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const omitThreshold = 0.3;
const estimate = text => Math.ceil(text.length / 4);
const key = value => `${value.file}::${value.name}`;

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const stddev = values => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
};
const percent = value => (value * 100).toFixed(1) + '%';
const number = value => Number(value.toFixed(3));

const snapshots = [];
const scoreObservations = [];
const coldLatencies = [];

for (let run = 1; run <= repetitions; run++) {
  const judge = new OpenRouterJevJudge(
    process.env.OPENROUTER_API_KEY,
    process.env.JEVTRACE_OPENROUTER_JEV_MODEL,
  );
  const adapter = new TypeScriptAdapter(root);
  adapter.findEntry(benchmarkCases[0].entry);

  const started = performance.now();

  for (const benchmarkCase of benchmarkCases) {
    // Collect a fixed depth-2 static graph independent of production thresholds.
    // body=0 / omit=0 makes the score sample independent of threshold gating.
    const result = await retrieve(
      adapter,
      judge,
      benchmarkCase.task,
      benchmarkCase.entry,
      {
        reverse: false,
        tokenBudget: 100000,
        maxNodes: 100,
        maxDepth: 2,
        wrapperLookahead: true,
        visitPolicy: 'score',
        bodyThreshold: 0,
        omitThreshold: 0,
      },
    );

    const gold = new Map(benchmarkCase.gold.map(target => [key(target), target]));
    const candidates = result.items
      .filter(item => item.depth > 0)
      .map(item => ({
        node: item.node,
        kind: item.kind,
        score: item.score ?? 0,
        gold: gold.has(key(item.node)),
        requiredLevel: gold.get(key(item.node))?.requiredLevel ?? 'signature',
      }));

    snapshots.push({
      run,
      caseId: benchmarkCase.id,
      entry: result.entry,
      goldCount: benchmarkCase.gold.length,
      candidates,
    });

    for (const candidate of candidates) {
      // Type edges are deterministic and are not sent to Jev.
      if (candidate.kind === 'type') continue;
      scoreObservations.push({
        run,
        caseId: benchmarkCase.id,
        symbol: key(candidate.node),
        gold: candidate.gold,
        score: candidate.score,
      });
    }
  }

  const elapsed = performance.now() - started;
  coldLatencies.push(elapsed);
  console.log(`cold run ${run}/${repetitions}: ${(elapsed / 1000).toFixed(2)}s`);
}

function classify(candidate, bodyThreshold) {
  let level;
  if (candidate.kind === 'type' || candidate.score > bodyThreshold) level = 'body';
  else if (candidate.score >= omitThreshold) level = 'signature';
  else level = 'omitted';

  if (candidate.node.external && level === 'body') level = 'signature';
  return level;
}

function scoreSnapshot(snapshot, bodyThreshold) {
  const classified = snapshot.candidates.map(candidate => ({
    ...candidate,
    level: classify(candidate, bodyThreshold),
  }));

  const included = classified.filter(candidate => candidate.level !== 'omitted');
  const includedGold = included.filter(candidate => candidate.gold);
  const goldCandidates = classified.filter(candidate => candidate.gold);
  const requiredHits = goldCandidates.filter(candidate => {
    if (candidate.requiredLevel === 'body') return candidate.level === 'body';
    return candidate.level === 'body' || candidate.level === 'signature';
  });

  let tokens = estimate(snapshot.entry.source);
  for (const candidate of included) {
    tokens += estimate(candidate.level === 'body' ? candidate.node.source : candidate.node.signature);
  }

  return {
    precision: included.length === 0 ? 0 : includedGold.length / included.length,
    recall: snapshot.goldCount === 0 ? 1 : includedGold.length / snapshot.goldCount,
    requiredRecall: snapshot.goldCount === 0 ? 1 : requiredHits.length / snapshot.goldCount,
    tokens,
    relevantPer1k: tokens === 0 ? 0 : (includedGold.length * 1000) / tokens,
    omittedGold: goldCandidates.filter(candidate => candidate.level === 'omitted').length,
  };
}

const thresholdRows = thresholds.map(bodyThreshold => {
  const metrics = snapshots.map(snapshot => scoreSnapshot(snapshot, bodyThreshold));
  return {
    bodyThreshold,
    precision: mean(metrics.map(metric => metric.precision)),
    recall: mean(metrics.map(metric => metric.recall)),
    requiredRecall: mean(metrics.map(metric => metric.requiredRecall)),
    avgTokens: mean(metrics.map(metric => metric.tokens)),
    relevantPer1k: mean(metrics.map(metric => metric.relevantPer1k)),
    omittedGold: metrics.reduce((sum, metric) => sum + metric.omittedGold, 0),
  };
});

const goldScores = scoreObservations.filter(item => item.gold).map(item => item.score);
const noiseScores = scoreObservations.filter(item => !item.gold).map(item => item.score);
const goldMin = Math.min(...goldScores);
const goldMax = Math.max(...goldScores);
const noiseMin = Math.min(...noiseScores);
const noiseMax = Math.max(...noiseScores);

console.log(`\nJevTrace cold stability benchmark — ${repetitions} runs × ${benchmarkCases.length} cases\n`);
console.table([
  {
    class: 'gold',
    observations: goldScores.length,
    mean: number(mean(goldScores)),
    stddev: number(stddev(goldScores)),
    min: number(goldMin),
    max: number(goldMax),
  },
  {
    class: 'noise',
    observations: noiseScores.length,
    mean: number(mean(noiseScores)),
    stddev: number(stddev(noiseScores)),
    min: number(noiseMin),
    max: number(noiseMax),
  },
]);

console.log(
  `Gold/noise separation: min(gold)=${goldMin.toFixed(3)}, max(noise)=${noiseMax.toFixed(3)}, ` +
  `margin=${(goldMin - noiseMax).toFixed(3)}.`,
);

console.log(`\nOffline body-threshold sweep across all ${repetitions} cold runs (omit threshold=${omitThreshold})\n`);
console.table(thresholdRows.map(row => ({
  bodyThreshold: row.bodyThreshold.toFixed(1),
  precision: percent(row.precision),
  recall: percent(row.recall),
  requiredRecall: percent(row.requiredRecall),
  avgTokens: Number(row.avgTokens.toFixed(2)),
  relevantPer1k: Number(row.relevantPer1k.toFixed(2)),
  omittedGold: row.omittedGold,
})));

const grouped = new Map();
for (const observation of scoreObservations) {
  const id = `${observation.caseId}::${observation.symbol}`;
  const group = grouped.get(id) ?? {
    caseId: observation.caseId,
    symbol: observation.symbol,
    gold: observation.gold,
    scores: [],
  };
  group.scores.push(observation.score);
  grouped.set(id, group);
}

const stabilityRows = [...grouped.values()].map(group => {
  const minimum = Math.min(...group.scores);
  const maximum = Math.max(...group.scores);
  const includeRate = group.scores.filter(score => score >= omitThreshold).length / group.scores.length;
  return {
    case: group.caseId,
    symbol: group.symbol,
    label: group.gold ? 'gold' : 'noise',
    mean: number(mean(group.scores)),
    stddev: number(stddev(group.scores)),
    min: number(minimum),
    max: number(maximum),
    range: number(maximum - minimum),
    includeRate: percent(includeRate),
  };
}).sort((a, b) => b.range - a.range || a.case.localeCompare(b.case));

console.log('\nPer-candidate score stability (largest ranges first)');
console.table(stabilityRows);

const unstable = stabilityRows.filter(row =>
  row.label === 'gold' ? row.includeRate !== '100.0%' : row.includeRate !== '0.0%',
);

console.log(
  `\nCandidates crossing omit threshold ${omitThreshold} across cold runs: ${unstable.length}/${stabilityRows.length}.`,
);
if (unstable.length) console.table(unstable);

console.log(
  `Cold-run wall time: mean ${(mean(coldLatencies) / 1000).toFixed(2)}s, ` +
  `min ${(Math.min(...coldLatencies) / 1000).toFixed(2)}s, ` +
  `max ${(Math.max(...coldLatencies) / 1000).toFixed(2)}s.`,
);
