// Head-to-head retrieval benchmark: JevTrace vs jevgrep (`jg`) on the source-reviewed JS/TS cases.
// Both tools answer the same task from the same checkout; both are scored on the text the coding agent
// would actually receive, with the same coverage rules and the same token estimator (characters / 4).
// Jev cost for both comes from the provider-reported response usage.
//
//   node --env-file=.env scripts/compare-jevgrep.mjs [--skip-jg] [--skip-jevtrace] [--case ID]
//
// jevgrep runs in Docker (it supports macOS/Linux only) at the version pinned in benchmarks/competitor/Dockerfile.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RepositoryIndex } from '../dist/discovery.js';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { createJudge } from '../dist/judges.js';
import { query } from '../dist/query.js';
import { formatContext } from '../dist/retrieve.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const outRoot = path.join(projectRoot, 'benchmarks', 'results', 'competitor');
const image = 'jevtrace-bench-jevgrep:0.7.0';

// ---- cases ---------------------------------------------------------------------------------------------
const cases = [];
const mounts = new Map();
for (const manifestFile of ['real-cases.json', 'holdout-cases.json']) {
  const manifestPath = path.join(projectRoot, 'benchmarks', manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const item of manifest.cases) {
    if (arg('--case') && item.id !== arg('--case')) continue;
    const root = path.resolve(path.dirname(manifestPath), manifest.repositories[item.repository].root);
    const containerRoot = `/repos/${item.repository}`;
    mounts.set(containerRoot, root);
    cases.push({ ...item, split: item.split ?? 'development', root, containerRoot });
  }
}
if (!cases.length) throw new Error('No cases selected');

// ---- scoring: the same rules for both tools ------------------------------------------------------------
const norm = file => file.replaceAll('\\', '/').replace(/^\.\//, '');
const addRange = (coverage, file, from, count) => {
  const lines = coverage.get(norm(file)) ?? new Set();
  for (let index = 0; index < count; index++) lines.add(from + index);
  coverage.set(norm(file), lines);
};

/**
 * jg: `Source block "file" lines a-b:` followed either by a fenced block of verbatim lines starting at `a`
 * (0.7.x) or by numbered `N: text` lines (older releases). Only lines actually present in stdout count.
 */
function jgCoverage(text) {
  const coverage = new Map();
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
  for (let index = 0; index < lines.length; index++) {
    const header = /^Source block "(.+?)" lines (\d+)-\d+:$/.exec(lines[index]);
    if (!header) continue;
    const [, file, start] = header;
    if (lines[index + 1]?.startsWith('```')) {
      let count = 0;
      for (let cursor = index + 2; cursor < lines.length && !lines[cursor].startsWith('```'); cursor++) count++;
      addRange(coverage, file, Number(start), count);
      continue;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const numbered = /^(\d+):(?: |$)/.exec(lines[cursor]);
      if (!numbered) break;
      addRange(coverage, file, Number(numbered[1]), 1);
    }
  }
  return coverage;
}

/** JevTrace: `### name — file:start-end [level...]` then a fenced block; only lines actually delivered count. */
function jevtraceCoverage(text) {
  const coverage = new Map();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const header = /^### .+ — (.+):(\d+)-(\d+) \[(body|signature)/.exec(lines[index]);
    if (!header || !lines[index + 1]?.startsWith('```')) continue;
    let count = 0;
    for (let cursor = index + 2; cursor < lines.length && !lines[cursor].startsWith('```'); cursor++) count++;
    addRange(coverage, header[1], Number(header[2]), count);
  }
  return coverage;
}

const declarationRanges = new Map();
function declarationRange(item, target) {
  const key = `${item.root}|${target.file}|${target.line}`;
  if (!declarationRanges.has(key)) {
    const node = new TypeScriptAdapter(item.root).findEntry({ file: target.file, line: target.line });
    declarationRanges.set(key, { start: node.startLine, end: node.endLine });
  }
  return declarationRanges.get(key);
}

function score(item, coverage) {
  const hits = item.required.map(target => {
    const { start, end } = declarationRange(item, target);
    const lines = coverage.get(norm(target.file)) ?? new Set();
    if (!lines.has(start)) return { name: target.name, hit: false };
    if ((target.requiredLevel ?? 'body') === 'signature') return { name: target.name, hit: true };
    let covered = 0;
    for (let line = start; line <= end; line++) if (lines.has(line)) covered++;
    return { name: target.name, hit: covered / (end - start + 1) >= 0.9 };
  });
  return { recall: hits.filter(hit => hit.hit).length / hits.length, missing: hits.filter(hit => !hit.hit).map(hit => hit.name) };
}
const tokens = text => Math.ceil(text.length / 4);

// ---- jevgrep (Docker) ----------------------------------------------------------------------------------
const jgConfigs = (process.env.JG_CONFIGS ?? 'default budget-32kb').split(/\s+/).filter(Boolean);
const jgDir = path.join(outRoot, arg('--jg-dir') ?? 'jg');
if (!process.argv.includes('--skip-jg')) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required (run with --env-file=.env)');
  execFileSync('docker', ['build', '-q', '-t', image, path.join(projectRoot, 'benchmarks', 'competitor')], { stdio: ['ignore', 'ignore', 'inherit'] });
  const benchDir = path.join(outRoot, 'bench');
  fs.mkdirSync(benchDir, { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'benchmarks', 'competitor', 'probe.mjs'), path.join(benchDir, 'probe.mjs'));
  fs.copyFileSync(path.join(projectRoot, 'benchmarks', 'competitor', 'run-jg.sh'), path.join(benchDir, 'run-jg.sh'));
  fs.writeFileSync(path.join(benchDir, 'cases.tsv'), cases.map(item => [item.id, item.containerRoot, item.task.replaceAll('\t', ' ')].join('\t')).join('\n') + '\n');
  const volumes = [...mounts].flatMap(([container, host]) => ['-v', `${host}:${container}:ro`]);
  const run = spawnSync('docker', ['run', '--rm', '-e', 'OPENROUTER_API_KEY', ...volumes,
    '-v', `${benchDir}:/bench:ro`, '-e', 'JG_CONFIGS', '-v', `${jgDir}:/out`, image, 'bash', '/bench/run-jg.sh'], { stdio: 'inherit', env: process.env });
  if (run.status !== 0) throw new Error(`jevgrep container exited with ${run.status}`);
}

// ---- JevTrace (runtime default: task-only, 8,000-token budget, MCP text formatting) -------------------
const usage = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  try { usage.push((await response.clone().json())?.usage ?? null); } catch { usage.push(null); }
  return response;
};
const jevtraceDir = path.join(outRoot, 'jevtrace');
if (!process.argv.includes('--skip-jevtrace')) {
  fs.mkdirSync(jevtraceDir, { recursive: true });
  for (const item of cases) {
    const before = usage.length;
    const started = performance.now();
    let text;
    try {
      const result = await query(new RepositoryIndex(item.root), new TypeScriptAdapter(item.root), createJudge(process.env), item.task, undefined, {});
      text = 'items' in result ? formatContext(result, 30000) : result.warnings.join('\n');
    } catch (error) {
      text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
    const calls = usage.slice(before);
    fs.writeFileSync(path.join(jevtraceDir, `${item.id}.txt`), text);
    fs.writeFileSync(path.join(jevtraceDir, `${item.id}.meta.json`), JSON.stringify({
      ms: Math.round(performance.now() - started), requests: calls.length,
      inputTokens: calls.reduce((sum, call) => sum + (call?.input_tokens ?? 0), 0),
      cost: calls.reduce((sum, call) => sum + (call?.cost ?? 0), 0),
    }));
    process.stderr.write(`jevtrace ${item.id}\n`);
  }
}

// ---- report --------------------------------------------------------------------------------------------
const readJg = (config, id) => {
  const dir = path.join(jgDir, config);
  const text = fs.existsSync(path.join(dir, `${id}.txt`)) ? fs.readFileSync(path.join(dir, `${id}.txt`), 'utf8') : '';
  const meta = fs.existsSync(path.join(dir, `${id}.meta.json`)) ? JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf8')) : {};
  const calls = fs.existsSync(path.join(dir, `${id}.usage.jsonl`))
    ? fs.readFileSync(path.join(dir, `${id}.usage.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).usage) : [];
  return { text, ms: meta.ms, exit: meta.exit, requests: calls.length, inputTokens: calls.reduce((sum, call) => sum + (call?.input_tokens ?? 0), 0), cost: calls.reduce((sum, call) => sum + (call?.cost ?? 0), 0) };
};
const readJevtrace = id => ({
  text: fs.readFileSync(path.join(jevtraceDir, `${id}.txt`), 'utf8'),
  ...JSON.parse(fs.readFileSync(path.join(jevtraceDir, `${id}.meta.json`), 'utf8')),
});

const tools = { jevtrace: readJevtrace, ...Object.fromEntries(jgConfigs.map(config => [`jg-${config}`, id => readJg(config, id)])) };
const rows = [];
for (const item of cases) {
  for (const [tool, read] of Object.entries(tools)) {
    const run = read(item.id);
    const coverage = tool === 'jevtrace' ? jevtraceCoverage(run.text) : jgCoverage(run.text);
    const { recall, missing } = score(item, coverage);
    rows.push({ case: item.id, split: item.split, tool, recall, missing, agentTokens: tokens(run.text), jevCost: run.cost, requests: run.requests, jevInputTokens: run.inputTokens, ms: run.ms, exit: run.exit });
  }
}
const report = { generatedAt: new Date().toISOString(), jevgrep: image, rules: 'body: declaration start line present and >=90% of its lines delivered; signature: start line delivered. Tokens: characters/4 of the delivered text.', rows };
fs.writeFileSync(path.join(outRoot, 'report.json'), JSON.stringify(report, null, 2));

const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
console.log('\nPer case (required-level recall · agent tokens · Jev cost)\n');
console.table(cases.map(item => Object.fromEntries([['case', item.id], ['split', item.split], ...Object.keys(tools).map(tool => {
  const row = rows.find(entry => entry.case === item.id && entry.tool === tool);
  return [tool, `${(row.recall * 100).toFixed(0)}% · ${row.agentTokens.toLocaleString()} · $${row.jevCost.toFixed(4)}`];
})])));
for (const split of ['development', 'holdout', 'all']) {
  console.log(`\nSummary: ${split}`);
  console.table(Object.keys(tools).map(tool => {
    const selected = rows.filter(row => row.tool === tool && (split === 'all' || row.split === split));
    return { tool, cases: selected.length, recall: `${(mean(selected.map(row => row.recall)) * 100).toFixed(1)}%`,
      fullRecallCases: selected.filter(row => row.recall === 1).length, agentTokens: Math.round(mean(selected.map(row => row.agentTokens))),
      jevCost: `$${mean(selected.map(row => row.jevCost)).toFixed(4)}`, requests: +mean(selected.map(row => row.requests)).toFixed(1), seconds: +(mean(selected.map(row => row.ms ?? 0)) / 1000).toFixed(1) };
  }));
}
console.log(`\nSaved outputs and report.json under ${path.relative(projectRoot, outRoot)}`);
