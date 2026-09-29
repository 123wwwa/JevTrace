import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RepositoryIndex } from '../dist/discovery.js';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge, createJudge } from '../dist/judges.js';
import { query } from '../dist/query.js';
import { retrieveTaskContext } from '../dist/task-pipeline.js';
import { scoreCandidatePoolRecall, scoreContextFootprint, scoreDiscovery, scoreLeadRecovery, scoreNeighborhoodStage, scoreRequiredContext, scoreSemanticLeadDistance } from '../dist/evaluate.js';

const arg = name => { const offset = process.argv.indexOf(name); return offset < 0 ? undefined : process.argv[offset + 1]; };
const manifestPath = path.resolve(arg('--manifest') ?? fileURLToPath(new URL('../benchmarks/real-cases.json', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.labelPolicy !== 'minimum-required-context') throw new Error('Unsupported real benchmark manifest');
const offline = process.argv.includes('--offline');
const split = arg('--split') ?? 'all';
if (!['all', 'development', 'holdout'].includes(split)) throw new Error('--split must be all, development, or holdout');
const cases = manifest.cases.filter(item => (!arg('--case') || item.id === arg('--case'))
  && (split === 'all' || (item.split ?? 'development') === split));
if (!cases.length) throw new Error('No benchmark cases selected');
const repeats = Number(arg('--repeats') ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be between 1 and 20');
const runs = [];
const roots = new Map();
for (const item of cases) {
  const repository = manifest.repositories[item.repository];
  const root = path.resolve(path.dirname(manifestPath), repository.root);
  if (!roots.has(root)) {
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (revision !== repository.revision) throw new Error(`Revision mismatch for ${item.repository}: expected ${repository.revision}, got ${revision}`);
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    if (dirty) throw new Error(`Tracked changes in ${item.repository}; use a clean pinned checkout for labeled evaluation`);
    roots.set(root, revision);
  }
  // Validate labels before any provider call; do not silently evaluate stale line coordinates.
  const validation = new TypeScriptAdapter(root);
  for (const target of item.required) {
    const resolved = validation.findEntry({ file: target.file, line: target.line, symbol: target.line ? undefined : target.name });
    if (resolved.name !== target.name) throw new Error(`Stale target ${item.id}: ${target.name} resolved as ${resolved.name}`);
  }
}
for (const item of cases) {
  const repository = manifest.repositories[item.repository];
  const root = path.resolve(path.dirname(manifestPath), repository.root);
  const modes = offline
    ? ['static-known-entry', 'pipeline-lexical-only']
    : ['static-known-entry', 'jev-known-entry', 'pipeline-baseline', 'pipeline-lexical-only', 'pipeline-no-stage4-jev', 'pipeline-no-lexical-final-merge', 'pipeline-pure-jev', 'pipeline-jev-leads-only'];
  for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const mode of modes) {
    process.stderr.write(`${item.id}: ${mode} repeat ${repeat}/${repeats}\n`);
    const adapter = new TypeScriptAdapter(root);
    const index = new RepositoryIndex(root);
    const started = performance.now();
    const runOptions = {
      ...manifest.options,
      maxCandidates: manifest.options.maxCandidates ?? 64,
      maxLeads: manifest.options.maxLeads ?? 4,
      reverseFanIn: manifest.options.reverseFanIn ?? 12,
    };

    let result;
    let discoveryJudgeName = 'explicit';
    let contextJudgeName = 'include-all';
    if (mode === 'static-known-entry' || mode === 'jev-known-entry') {
      const judge = mode === 'jev-known-entry'
        ? createJudge(process.env, { provider: arg('--provider'), model: arg('--model') })
        : new IncludeAllJudge();
      contextJudgeName = judge.name;
      result = await query(index, adapter, judge, item.task, item.entry, runOptions);
    } else {
      const lexicalOnly = mode === 'pipeline-lexical-only';
      const useJevContextRanking = mode === 'pipeline-baseline' || mode === 'pipeline-no-lexical-final-merge' || mode === 'pipeline-pure-jev';
      const includeLexicalParallel = !['pipeline-no-lexical-final-merge', 'pipeline-pure-jev', 'pipeline-jev-leads-only'].includes(mode);
      const includeLexicalHints = mode !== 'pipeline-pure-jev';
      const includeCompilerExpansion = mode !== 'pipeline-jev-leads-only';
      const discoveryJudge = lexicalOnly
        ? new IncludeAllJudge()
        : createJudge(process.env, { provider: arg('--provider'), model: arg('--model') });
      const contextJudge = useJevContextRanking
        ? createJudge(process.env, { provider: arg('--provider'), model: arg('--model') })
        : new IncludeAllJudge();
      discoveryJudgeName = discoveryJudge.name;
      contextJudgeName = contextJudge.name;
      result = await retrieveTaskContext(index, adapter, discoveryJudge, contextJudge, item.task, {
        ...runOptions,
        tokenBudget: manifest.options.pipelineTokenBudget ?? 8000,
        perLeadTokenBudget: manifest.options.pipelinePerLeadTokenBudget ?? 8000,
        neighborhoodTokenBudget: manifest.options.pipelineNeighborhoodTokenBudget ?? 16000,
        lexicalMergeLimit: manifest.options.lexicalMergeLimit ?? 16,
        includeLexicalParallel,
        includeLexicalHints,
        includeCompilerExpansion,
        contextRanking: useJevContextRanking ? 'jev' : 'structural',
      });
    }
    const totalMs = performance.now() - started;
    const traces = 'judgeTrace' in result ? result.judgeTrace : [];
    const entryBatches = result.discovery?.judgeStats.batches ?? [];
    const directoryBatches = result.discovery?.directoryJudgeStats?.batches ?? [];
    const fileBatches = result.discovery?.fileJudgeStats?.batches ?? [];
    const symbolBatches = result.discovery?.symbolJudgeStats?.batches ?? [];
    const pipeline = 'neighborhood' in result ? result : undefined;
    const stage1 = result.discovery ? scoreCandidatePoolRecall(adapter, result.discovery.localCandidates, item.required) : undefined;
    const stage2 = result.discovery ? scoreSemanticLeadDistance(adapter, result.discovery.semanticLeads, item.required) : undefined;
    const stage3 = scoreNeighborhoodStage(pipeline, item.required);
    runs.push({ caseId: item.id, repository: item.repository, revision: repository.revision, method: mode, repeat,
      discoveryJudge: discoveryJudgeName, contextJudge: contextJudgeName,
      status: result.status,
      stages: {
        lexicalCandidateRecall: stage1,
        semanticLeads: stage2,
        neighborhood: pipeline ? stage3 : undefined,
        contextRankingApplied: pipeline?.contextRankingApplied,
      },
      context: scoreRequiredContext('items' in result ? result : undefined, item.required),
      footprint: scoreContextFootprint('items' in result ? result : undefined, item.required),
      leadRecovery: scoreLeadRecovery('items' in result ? result : undefined, item.acceptableEntries),
      discovery: result.discovery ? scoreDiscovery(result.discovery, item.acceptableEntries) : undefined,
      directoryLeads: result.discovery?.directoryLeads.slice(0, 8),
      fileLeads: result.discovery?.fileLeads.slice(0, 8).map(file => ({ file: file.file, score: file.score })),
      semanticLeads: result.discovery?.semanticLeads.map(lead => ({ file: lead.file, line: lead.line, name: lead.name, retrievalScore: lead.retrievalScore, score: lead.score })),
      totalMs, discoveryMs: result.discovery?.latencyMs ?? 0,
      usedTokens: 'usedTokens' in result ? result.usedTokens : 0,
      rankingPoolTokens: pipeline?.rankingPool.stats.tokens,
      rankingPoolSymbols: pipeline?.rankingPool.stats.symbols,
      omittedCount: 'omitted' in result ? result.omitted.length : 0,
      budgetPressure: pipeline ? pipeline.rankingPool.stats.tokens / Math.max(pipeline.tokenBudget, 1) : undefined,
      providerRequests: traces.reduce((sum, trace) => sum + trace.providerRequests, 0) + entryBatches.reduce((sum, batch) => sum + batch.attempts, 0),
      payloadBytes: traces.reduce((sum, trace) => sum + trace.payloadBytes, 0) + entryBatches.reduce((sum, batch) => sum + batch.payloadBytes, 0),
      discoveryBreakdown: {
        directoryRequests: directoryBatches.reduce((sum, batch) => sum + batch.attempts, 0),
        fileRequests: fileBatches.reduce((sum, batch) => sum + batch.attempts, 0),
        symbolRequests: symbolBatches.reduce((sum, batch) => sum + batch.attempts, 0),
        directoryMs: result.discovery?.stageLatencyMs?.directory ?? 0,
        fileMs: result.discovery?.stageLatencyMs?.file ?? 0,
        symbolMs: result.discovery?.stageLatencyMs?.symbol ?? 0,
      },
      contextRankingMs: pipeline?.contextRankingLatencyMs ?? 0,
      diagnostics: { warnings: result.warnings, selected: result.discovery?.selected, leads: result.discovery?.semanticLeads, unresolvedCount: 'unresolved' in result ? result.unresolved.length : 0 },
      ...(process.argv.includes('--details') ? { result } : {}) });
  }
  }
}
const output = { schemaVersion: 1, labelPolicy: manifest.labelPolicy, generatedAt: new Date().toISOString(), options: manifest.options, repeats, split, runs };
const outputPath = arg('--output') ? path.resolve(arg('--output')) : undefined;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
}

const percent = value => value === undefined ? '-' : `${(value * 100).toFixed(0)}%`;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stddev = values => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const meanSd = (values, digits = 0) => `${mean(values).toFixed(digits)}±${stddev(values).toFixed(digits)}`;
const percentMeanSd = values => `${(mean(values) * 100).toFixed(1)}%±${(stddev(values) * 100).toFixed(1)}pp`;
const grouped = new Map();
for (const run of runs) {
  const key = `${run.caseId}::${run.method}`;
  const rows = grouped.get(key) ?? [];
  rows.push(run);
  grouped.set(key, rows);
}
const summary = [...grouped.values()].map(rows => {
  const run = rows[0];
  const recalls = rows.map(row => row.context?.requiredLevelRecall ?? 0);
  const densities = rows.map(row => row.footprint?.minimumRequiredDensity ?? 0);
  const pressures = rows.flatMap(row => row.budgetPressure === undefined ? [] : [row.budgetPressure]);
  const directoryReq = rows.map(row => row.discoveryBreakdown?.directoryRequests ?? 0);
  const fileReq = rows.map(row => row.discoveryBreakdown?.fileRequests ?? 0);
  const symbolReq = rows.map(row => row.discoveryBreakdown?.symbolRequests ?? 0);
  return {
    case: run.caseId,
    method: run.method,
    recall: rows.length === 1 ? percent(recalls[0]) : percentMeanSd(recalls),
    lexicalStrict: rows.length === 1 ? percent(run.stages?.lexicalCandidateRecall?.strictRecallAt64) : percentMeanSd(rows.map(row => row.stages?.lexicalCandidateRecall?.strictRecallAt64 ?? 0)),
    neighborhood: rows.length === 1 ? percent(run.stages?.neighborhood?.recall) : percentMeanSd(rows.map(row => row.stages?.neighborhood?.recall ?? 0)),
    leadsWithin1: rows.length === 1 ? percent(run.stages?.semanticLeads?.within1) : percentMeanSd(rows.map(row => row.stages?.semanticLeads?.within1 ?? 0)),
    tokens: meanSd(rows.map(row => row.usedTokens), 0),
    poolTokens: run.rankingPoolTokens === undefined ? '-' : meanSd(rows.map(row => row.rankingPoolTokens ?? 0), 0),
    pressure: pressures.length ? `${mean(pressures).toFixed(1)}x` : '-',
    density: rows.length === 1 ? percent(densities[0]) : percentMeanSd(densities),
    requests: meanSd(rows.map(row => row.providerRequests), 1),
    stage2Req: run.discovery ? `${mean(directoryReq).toFixed(1)}/${mean(fileReq).toFixed(1)}/${mean(symbolReq).toFixed(1)}` : '-',
    discoveryMs: meanSd(rows.map(row => row.discoveryMs), 0),
    totalMs: meanSd(rows.map(row => row.totalMs), 0),
    finalJev: run.stages?.contextRankingApplied === undefined ? '-' : rows.some(row => row.stages?.contextRankingApplied) ? 'yes' : 'no',
  };
});

console.log('\nJevTrace real-task suite summary\n');
console.table(summary);
if (outputPath) console.log(`Full JSON saved to: ${outputPath}`);
else console.log('Full JSON is not printed by default. Use --output <file.json> to save it, or --json to print it.');
if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
