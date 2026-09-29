import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RepositoryIndex } from '../dist/discovery.js';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { createJudge } from '../dist/judges.js';
import { retrieveTaskContext } from '../dist/task-pipeline.js';
import { scoreContextFootprint, scoreRequiredContext } from '../dist/evaluate.js';

const arg = name => {
  const offset = process.argv.indexOf(name);
  return offset < 0 ? undefined : process.argv[offset + 1];
};
const percent = value => value === undefined ? '-' : `${(value * 100).toFixed(0)}%`;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stddev = values => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const fmtMeanSd = (values, digits = 1) => `${mean(values).toFixed(digits)} ± ${stddev(values).toFixed(digits)}`;
const fmtPercentMeanSd = values => `${(mean(values) * 100).toFixed(1)}% ± ${(stddev(values) * 100).toFixed(1)}pp`;

const manifestPath = path.resolve(arg('--manifest') ?? fileURLToPath(new URL('../benchmarks/real-cases.json', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.labelPolicy !== 'minimum-required-context') {
  throw new Error('Unsupported real benchmark manifest');
}

const budgets = (arg('--budgets') ?? '2000,4000,6000,8000')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(Number.isFinite);
if (!budgets.length || budgets.some(value => !Number.isInteger(value) || value < 1)) {
  throw new Error('--budgets must be a comma-separated list of positive integer token budgets');
}
const uniqueBudgets = [...new Set(budgets)].sort((a, b) => a - b);

const repeats = Number(arg('--repeats') ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
  throw new Error('--repeats must be an integer between 1 and 20');
}

const split = arg('--split') ?? 'all';
if (!['all', 'development', 'holdout'].includes(split)) {
  throw new Error('--split must be all, development, or holdout');
}

const cases = manifest.cases.filter(item =>
  (!arg('--case') || item.id === arg('--case'))
  && (split === 'all' || (item.split ?? 'development') === split));
if (!cases.length) throw new Error('No benchmark cases selected');

const roots = new Map();
for (const item of cases) {
  const repository = manifest.repositories[item.repository];
  const root = path.resolve(path.dirname(manifestPath), repository.root);
  if (!roots.has(root)) {
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (revision !== repository.revision) {
      throw new Error(`Revision mismatch for ${item.repository}: expected ${repository.revision}, got ${revision}`);
    }
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    if (dirty) throw new Error(`Tracked changes in ${item.repository}; use a clean pinned checkout for labeled evaluation`);
    roots.set(root, revision);
  }

  const validation = new TypeScriptAdapter(root);
  for (const target of item.required) {
    const resolved = validation.findEntry({
      file: target.file,
      line: target.line,
      symbol: target.line ? undefined : target.name,
    });
    if (resolved.name !== target.name) {
      throw new Error(`Stale target ${item.id}: ${target.name} resolved as ${resolved.name}`);
    }
  }
}

const targetMatches = (target, node) =>
  node.file === target.file
  && (target.line !== undefined
    ? node.startLine <= target.line && node.endLine >= target.line
    : node.name === target.name);

const orderItems = (items, mode) => [...items].sort((a, b) => {
  const aScore = mode === 'jev' ? (a.finalScore ?? 0) : a.structuralScore;
  const bScore = mode === 'jev' ? (b.finalScore ?? 0) : b.structuralScore;
  return bScore - aScore
    || b.structuralScore - a.structuralScore
    || a.depth - b.depth
    || a.node.id.localeCompare(b.node.id);
});

const selectWithinBudget = (ordered, tokenBudget) => {
  const selected = [];
  let usedTokens = 0;
  for (const item of ordered) {
    if (usedTokens + item.estimatedTokens > tokenBudget) continue;
    selected.push(item);
    usedTokens += item.estimatedTokens;
  }
  return {
    items: selected.map(item => ({
      node: item.node,
      level: item.node.external ? 'signature' : 'body',
      depth: item.depth,
    })),
    usedTokens,
  };
};

const rankTargets = (ordered, targets) => targets.map(target => {
  const index = ordered.findIndex(item => targetMatches(target, item.node));
  return {
    file: target.file,
    name: target.name,
    requiredLevel: target.requiredLevel,
    rank: index < 0 ? undefined : index + 1,
  };
});

const stageStats = stats => {
  const batches = stats?.batches ?? [];
  const attempts = batches.reduce((sum, batch) => sum + batch.attempts, 0);
  return {
    batches: batches.length,
    attempts,
    retries: Math.max(0, attempts - batches.filter(batch => !batch.cacheHit).length),
    candidates: batches.reduce((sum, batch) => sum + batch.candidates, 0),
    payloadBytes: batches.reduce((sum, batch) => sum + batch.payloadBytes, 0),
    latencyMs: batches.reduce((sum, batch) => sum + batch.latencyMs, 0),
    batchSizes: batches.map(batch => batch.candidates),
    cacheHits: batches.filter(batch => batch.cacheHit).length,
  };
};

const normalizeIdentifier = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const terminalIdentifier = value => value.split(/::|#|\./).filter(Boolean).at(-1) ?? value;
const fileStem = value => path.basename(value).replace(/\.[^.]+$/, '');
const identifierTokens = value =>
  (terminalIdentifier(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [])
    .filter(token => token.length > 2);

const leakageAudit = item => {
  const normalizedTask = normalizeIdentifier(item.task);
  const taskTerms = new Set((item.task
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []).filter(token => token.length > 2));
  const exactIdentifierMentions = [];
  const pathStemMentions = [];
  const tokenOverlap = [];

  for (const target of item.required) {
    const terminal = terminalIdentifier(target.name);
    const normalized = normalizeIdentifier(terminal);
    if (normalized.length >= 4 && normalizedTask.includes(normalized)) {
      exactIdentifierMentions.push({ name: target.name, identifier: terminal });
    }
    const stem = fileStem(target.file);
    const normalizedStem = normalizeIdentifier(stem);
    if (normalizedStem.length >= 4 && normalizedTask.includes(normalizedStem)) {
      pathStemMentions.push({ file: target.file, stem });
    }
    const tokens = identifierTokens(target.name);
    const overlap = tokens.filter(token => taskTerms.has(token));
    tokenOverlap.push({ name: target.name, tokens, overlap });
  }
  return { exactIdentifierMentions, pathStemMentions, tokenOverlap };
};

const runs = [];
const repetitionsMeta = [];
const leakage = cases.map(item => ({ caseId: item.id, ...leakageAudit(item) }));

for (const item of cases) {
  const repository = manifest.repositories[item.repository];
  const root = path.resolve(path.dirname(manifestPath), repository.root);

  for (let repeat = 1; repeat <= repeats; repeat++) {
    process.stderr.write(`${item.id}: Stage 4 cold ranking repeat ${repeat}/${repeats}\n`);

    const adapter = new TypeScriptAdapter(root);
    const index = new RepositoryIndex(root);
    const discoveryJudge = createJudge(process.env, { provider: arg('--provider'), model: arg('--model') });
    const contextJudge = createJudge(process.env, { provider: arg('--provider'), model: arg('--model') });
    const started = performance.now();

    // Force Stage 4 to score the merged pool once. The scored pool is then replayed
    // under every requested final token budget, so Jev and structural ordering see
    // exactly the same candidates and compiler/lexical evidence.
    const result = await retrieveTaskContext(index, adapter, discoveryJudge, contextJudge, item.task, {
      ...manifest.options,
      maxCandidates: manifest.options.maxCandidates ?? 64,
      maxLeads: manifest.options.maxLeads ?? 4,
      reverseFanIn: manifest.options.reverseFanIn ?? 12,
      tokenBudget: 1,
      perLeadTokenBudget: manifest.options.pipelinePerLeadTokenBudget ?? 8000,
      neighborhoodTokenBudget: manifest.options.pipelineNeighborhoodTokenBudget ?? 16000,
      lexicalMergeLimit: manifest.options.lexicalMergeLimit ?? 64,
      includeLexicalParallel: true,
      includeLexicalHints: true,
      includeCompilerExpansion: true,
      contextRanking: 'jev',
    });

    if (!('rankingPool' in result) || !result.contextRankingApplied) {
      throw new Error(`Stage 4 did not run for ${item.id} repeat ${repeat}`);
    }

    const totalMs = performance.now() - started;
    const items = result.rankingPool.items;
    const jevOrder = orderItems(items, 'jev');
    const structuralOrder = orderItems(items, 'structural');
    const jevRanks = rankTargets(jevOrder, item.required);
    const structuralRanks = rankTargets(structuralOrder, item.required);

    const rankChanges = item.required.map((target, index) => ({
      file: target.file,
      name: target.name,
      structuralRank: structuralRanks[index].rank,
      jevRank: jevRanks[index].rank,
      gain: structuralRanks[index].rank !== undefined && jevRanks[index].rank !== undefined
        ? structuralRanks[index].rank - jevRanks[index].rank
        : undefined,
    }));

    const stage4 = { ...stageStats(result.contextJudgeStats), wallLatencyMs: result.contextRankingLatencyMs };
    const directory = { ...stageStats(result.discovery.directoryJudgeStats), wallLatencyMs: result.discovery.stageLatencyMs.directory };
    const file = { ...stageStats(result.discovery.fileJudgeStats), wallLatencyMs: result.discovery.stageLatencyMs.file };
    const symbol = { ...stageStats(result.discovery.symbolJudgeStats), wallLatencyMs: result.discovery.stageLatencyMs.symbol };
    repetitionsMeta.push({
      caseId: item.id,
      repository: item.repository,
      split: item.split ?? 'development',
      repeat,
      rankingPoolSymbols: items.length,
      rankingPoolTokens: result.rankingPool.stats.tokens,
      lexicalAdded: result.rankingPool.stats.lexicalAdded,
      rankChanges,
      stage4,
      discovery: {
        directory,
        file,
        symbol,
        totalRequests: directory.attempts + file.attempts + symbol.attempts,
        latencyMs: result.discovery.latencyMs,
      },
      totalMs,
    });

    for (const budget of uniqueBudgets) {
      const structuralResult = selectWithinBudget(structuralOrder, budget);
      const jevResult = selectWithinBudget(jevOrder, budget);
      const structuralContext = scoreRequiredContext(structuralResult, item.required);
      const jevContext = scoreRequiredContext(jevResult, item.required);
      const structuralFootprint = scoreContextFootprint(structuralResult, item.required);
      const jevFootprint = scoreContextFootprint(jevResult, item.required);
      const structuralIds = new Set(structuralResult.items.map(contextItem => contextItem.node.id));
      const jevIds = new Set(jevResult.items.map(contextItem => contextItem.node.id));
      const selectionChanges = [...new Set([...structuralIds, ...jevIds])]
        .filter(id => structuralIds.has(id) !== jevIds.has(id)).length;

      runs.push({
        caseId: item.id,
        repository: item.repository,
        split: item.split ?? 'development',
        repeat,
        budget,
        poolTokens: result.rankingPool.stats.tokens,
        poolSymbols: result.rankingPool.stats.symbols,
        pressure: result.rankingPool.stats.tokens / budget,
        structural: {
          context: structuralContext,
          footprint: structuralFootprint,
          omittedSymbols: Math.max(0, structuralOrder.length - structuralResult.items.length),
        },
        jev: {
          context: jevContext,
          footprint: jevFootprint,
          omittedSymbols: Math.max(0, jevOrder.length - jevResult.items.length),
        },
        recallDelta: jevContext.requiredLevelRecall - structuralContext.requiredLevelRecall,
        densityDelta: jevFootprint.minimumRequiredDensity - structuralFootprint.minimumRequiredDensity,
        selectionChanges,
      });
    }
  }
}

const caseBudgetAggregates = [];
for (const item of cases) {
  for (const budget of uniqueBudgets) {
    const rows = runs.filter(run => run.caseId === item.id && run.budget === budget);
    caseBudgetAggregates.push({
      caseId: item.id,
      budget,
      repeats: rows.length,
      structuralRecallMean: mean(rows.map(row => row.structural.context.requiredLevelRecall)),
      structuralRecallSd: stddev(rows.map(row => row.structural.context.requiredLevelRecall)),
      jevRecallMean: mean(rows.map(row => row.jev.context.requiredLevelRecall)),
      jevRecallSd: stddev(rows.map(row => row.jev.context.requiredLevelRecall)),
      recallDeltaMean: mean(rows.map(row => row.recallDelta)),
      structuralDensityMean: mean(rows.map(row => row.structural.footprint.minimumRequiredDensity)),
      jevDensityMean: mean(rows.map(row => row.jev.footprint.minimumRequiredDensity)),
      structuralTokensMean: mean(rows.map(row => row.structural.footprint.usedTokens)),
      jevTokensMean: mean(rows.map(row => row.jev.footprint.usedTokens)),
      pressureMean: mean(rows.map(row => row.pressure)),
      wins: rows.filter(row => row.recallDelta > 0).length,
      ties: rows.filter(row => row.recallDelta === 0).length,
      losses: rows.filter(row => row.recallDelta < 0).length,
    });
  }
}

const aggregates = uniqueBudgets.map(budget => {
  const rows = runs.filter(run => run.budget === budget);
  const structuralRecalls = rows.map(run => run.structural.context.requiredLevelRecall);
  const jevRecalls = rows.map(run => run.jev.context.requiredLevelRecall);
  const structuralDensities = rows.map(run => run.structural.footprint.minimumRequiredDensity);
  const jevDensities = rows.map(run => run.jev.footprint.minimumRequiredDensity);
  return {
    budget,
    observations: rows.length,
    structuralRecallMean: mean(structuralRecalls),
    structuralRecallSd: stddev(structuralRecalls),
    jevRecallMean: mean(jevRecalls),
    jevRecallSd: stddev(jevRecalls),
    deltaMean: mean(rows.map(run => run.recallDelta)),
    structuralDensityMean: mean(structuralDensities),
    jevDensityMean: mean(jevDensities),
    densityDeltaMean: mean(rows.map(run => run.densityDelta)),
    pressureMean: mean(rows.map(run => run.pressure)),
    wins: rows.filter(run => run.recallDelta > 0).length,
    ties: rows.filter(run => run.recallDelta === 0).length,
    losses: rows.filter(run => run.recallDelta < 0).length,
  };
});

const targetRankAggregates = [];
for (const item of cases) {
  for (const target of item.required) {
    const rows = repetitionsMeta
      .filter(meta => meta.caseId === item.id)
      .map(meta => meta.rankChanges.find(change => change.name === target.name && change.file === target.file))
      .filter(Boolean);
    const structuralRanks = rows.flatMap(row => row.structuralRank === undefined ? [] : [row.structuralRank]);
    const jevRanks = rows.flatMap(row => row.jevRank === undefined ? [] : [row.jevRank]);
    const gains = rows.flatMap(row => row.gain === undefined ? [] : [row.gain]);
    targetRankAggregates.push({
      caseId: item.id,
      target: target.name,
      structuralRankMean: structuralRanks.length ? mean(structuralRanks) : undefined,
      jevRankMean: jevRanks.length ? mean(jevRanks) : undefined,
      gainMean: gains.length ? mean(gains) : undefined,
      observations: rows.length,
    });
  }
}

const providerAggregates = cases.map(item => {
  const rows = repetitionsMeta.filter(meta => meta.caseId === item.id);
  return {
    caseId: item.id,
    poolTokens: rows.map(row => row.rankingPoolTokens),
    poolSymbols: rows.map(row => row.rankingPoolSymbols),
    stage4Requests: rows.map(row => row.stage4.attempts),
    stage4Batches: rows.map(row => row.stage4.batches),
    stage4Retries: rows.map(row => row.stage4.retries),
    stage4LatencyMs: rows.map(row => row.stage4.wallLatencyMs),
    stage4Candidates: rows.map(row => row.stage4.candidates),
    stage4PayloadBytes: rows.map(row => row.stage4.payloadBytes),
    directoryRequests: rows.map(row => row.discovery.directory.attempts),
    directoryLatencyMs: rows.map(row => row.discovery.directory.wallLatencyMs),
    directoryCandidates: rows.map(row => row.discovery.directory.candidates),
    fileRequests: rows.map(row => row.discovery.file.attempts),
    fileLatencyMs: rows.map(row => row.discovery.file.wallLatencyMs),
    fileCandidates: rows.map(row => row.discovery.file.candidates),
    symbolRequests: rows.map(row => row.discovery.symbol.attempts),
    symbolLatencyMs: rows.map(row => row.discovery.symbol.wallLatencyMs),
    symbolCandidates: rows.map(row => row.discovery.symbol.candidates),
    discoveryTotalRequests: rows.map(row => row.discovery.totalRequests),
    discoveryLatencyMs: rows.map(row => row.discovery.latencyMs),
  };
});

const output = {
  schemaVersion: 2,
  experiment: 'stage4-budget-sweep',
  labelPolicy: manifest.labelPolicy,
  generatedAt: new Date().toISOString(),
  split,
  repeats,
  budgets: uniqueBudgets,
  leakageAudit: leakage,
  repetitions: repetitionsMeta,
  runs,
  caseBudgetAggregates,
  aggregates,
  targetRankAggregates,
  providerAggregates,
};

const outputPath = arg('--output') ? path.resolve(arg('--output')) : undefined;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
}

console.log('\nStage 4 opportunity: ranking-pool pressure\n');
const minBudget = uniqueBudgets[0];
const maxBudget = uniqueBudgets.at(-1);
console.table(providerAggregates.map(row => ({
  case: row.caseId,
  poolTokens: fmtMeanSd(row.poolTokens, 0),
  poolSymbols: fmtMeanSd(row.poolSymbols, 1),
  [`pressure@${minBudget}`]: `${(mean(row.poolTokens) / minBudget).toFixed(1)}x`,
  [`pressure@${maxBudget}`]: `${(mean(row.poolTokens) / maxBudget).toFixed(1)}x`,
})));

console.log('\nStage 4 budget sweep — per case, repeated\n');
console.table(caseBudgetAggregates.map(row => ({
  case: row.caseId,
  budget: row.budget,
  structuralRecall: `${(row.structuralRecallMean * 100).toFixed(1)}% ± ${(row.structuralRecallSd * 100).toFixed(1)}pp`,
  jevRecall: `${(row.jevRecallMean * 100).toFixed(1)}% ± ${(row.jevRecallSd * 100).toFixed(1)}pp`,
  delta: `${row.recallDeltaMean >= 0 ? '+' : ''}${(row.recallDeltaMean * 100).toFixed(1)}pp`,
  structuralDensity: percent(row.structuralDensityMean),
  jevDensity: percent(row.jevDensityMean),
  pressure: `${row.pressureMean.toFixed(1)}x`,
  W_T_L: `${row.wins}/${row.ties}/${row.losses}`,
})));

console.log('\nAggregate Stage 4 effect\n');
console.table(aggregates.map(row => ({
  budget: row.budget,
  structuralRecall: `${(row.structuralRecallMean * 100).toFixed(1)}% ± ${(row.structuralRecallSd * 100).toFixed(1)}pp`,
  jevRecall: `${(row.jevRecallMean * 100).toFixed(1)}% ± ${(row.jevRecallSd * 100).toFixed(1)}pp`,
  delta: `${row.deltaMean >= 0 ? '+' : ''}${(row.deltaMean * 100).toFixed(1)}pp`,
  structuralDensity: percent(row.structuralDensityMean),
  jevDensity: percent(row.jevDensityMean),
  densityDelta: `${row.densityDeltaMean >= 0 ? '+' : ''}${(row.densityDeltaMean * 100).toFixed(1)}pp`,
  pressure: `${row.pressureMean.toFixed(1)}x`,
  W_T_L: `${row.wins}/${row.ties}/${row.losses}`,
})));

console.log('\nRequired-target rank changes (positive gain = Jev moved target earlier)\n');
console.table(targetRankAggregates.map(row => ({
  case: row.caseId,
  target: row.target,
  structuralRank: row.structuralRankMean === undefined ? '-' : row.structuralRankMean.toFixed(1),
  jevRank: row.jevRankMean === undefined ? '-' : row.jevRankMean.toFixed(1),
  gain: row.gainMean === undefined ? '-' : row.gainMean.toFixed(1),
})));

console.log('\nProvider cost breakdown — mean ± sample SD across cold repeats\n');
console.table(providerAggregates.map(row => ({
  case: row.caseId,
  stage4Cand: fmtMeanSd(row.stage4Candidates, 0),
  stage4Req: fmtMeanSd(row.stage4Requests, 1),
  stage4Batches: fmtMeanSd(row.stage4Batches, 1),
  stage4Retries: fmtMeanSd(row.stage4Retries, 1),
  stage4Ms: fmtMeanSd(row.stage4LatencyMs, 0),
  dirCand: fmtMeanSd(row.directoryCandidates, 0),
  dirReq: fmtMeanSd(row.directoryRequests, 1),
  dirMs: fmtMeanSd(row.directoryLatencyMs, 0),
  fileCand: fmtMeanSd(row.fileCandidates, 0),
  fileReq: fmtMeanSd(row.fileRequests, 1),
  fileMs: fmtMeanSd(row.fileLatencyMs, 0),
  symbolCand: fmtMeanSd(row.symbolCandidates, 0),
  symbolReq: fmtMeanSd(row.symbolRequests, 1),
  symbolMs: fmtMeanSd(row.symbolLatencyMs, 0),
})));

console.log('\nTask leakage audit\n');
console.table(leakage.map(row => ({
  case: row.caseId,
  exactIdentifierMentions: row.exactIdentifierMentions.map(item => item.identifier).join(', ') || '-',
  pathStemMentions: row.pathStemMentions.map(item => item.stem).join(', ') || '-',
  overlappingIdentifierTokens: row.tokenOverlap
    .filter(item => item.overlap.length)
    .map(item => `${item.name}:[${item.overlap.join(',')}]`)
    .join(' ') || '-',
})));

if (!manifest.cases.some(item => (item.split ?? 'development') === 'holdout')) {
  console.log('\nNo holdout cases exist in this manifest yet. Current cases are development data and should not be used as a final untouched evaluation set.');
}
if (outputPath) console.log(`Full JSON saved to: ${outputPath}`);
else console.log('Use --output <file.json> to save all repeat-level details.');
