// Captures what the video shows from real runs, so no number or symbol in it is made up:
//   src/data/demo.json    one JevTrace query: the task, how much it searched, the leads Jev chose, lexical
//                         matches it passed over, and the compiler edges around the top lead.
//   src/data/metrics.json how much less context an agent reads with JevTrace (the agent benchmark,
//                         docs/agent-benchmark.md) and how much of the needed code JevTrace finds (the
//                         retrieval benchmark, docs/benchmark-vs-jevgrep.md).
//
//   node --env-file=../.env scripts/capture-demo.mjs [--repo ../../hono] [--task "..."] [--metrics-only]
// Needs a JevTrace build (npm run build in the repository root) and a provider, except with --metrics-only,
// which only reads the benchmark reports. CI renders from the saved JSON.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const videoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(videoRoot, '..');
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const repo = path.resolve(arg('--repo', path.join(projectRoot, '..', 'hono')));
const task = arg('--task', 'Allow a configurable clock-skew tolerance when checking whether a signed bearer token is expired or not yet valid');
const dataDir = path.join(videoRoot, 'src', 'data');
fs.mkdirSync(dataDir, { recursive: true });

if (!process.argv.includes('--metrics-only')) {
  const raw = execFileSync(process.execPath, [path.join(projectRoot, 'dist', 'cli.js'), 'query', '--root', repo, '--task', task],
    { encoding: 'utf8', env: { ...process.env, JEVTRACE_USAGE_LOG: 'off' }, maxBuffer: 64 * 1024 * 1024 });
  const result = JSON.parse(raw);
  if (!result.items?.length) throw new Error(`JevTrace returned no context (${result.status})`);

  const short = file => file.split('/').slice(-3).join('/');
  const leads = result.discovery.semanticLeads.slice(0, 3).map(lead => ({ name: lead.name, file: short(lead.file), score: Number((lead.score ?? 0).toFixed(2)) }));
  const kept = new Set(result.items.map(item => item.node.name));
  const passedOver = result.discovery.lexicalCandidates.filter(candidate => !kept.has(candidate.name)).slice(0, 5)
    .map(candidate => ({ name: candidate.name, file: short(candidate.file) }));

  // Edges drawn around the top lead, one or two per kind, in the order the scene reveals them.
  const focus = result.items.find(item => item.node.name === leads[0].name);
  // A neighbour with the lead's own name (another module's `verify`) would read as a loop on screen.
  const fromFocus = result.items.filter(item => item.from === focus?.node.id && item.node.name !== focus.node.name);
  const displayName = name => {
    const plain = name.replace(/ callback$/, '');
    return plain.length > 34 ? `${plain.slice(0, 32)}…` : plain;
  };
  const ofKind = (kinds, pool) => pool.filter(item => kinds.includes(item.kind));
  const edges = [['caller', ['caller'], 1], ['calls', ['call', 'method'], 1], ['type', ['type'], 1], ['throws', ['new'], 2], ['test', ['test'], 1]]
    .flatMap(([label, kinds, count]) => {
      // The top lead's own tests when it has any, otherwise a test another lead brought in.
      const own = ofKind(kinds, fromFocus);
      const pool = own.length || label !== 'test' ? own : ofKind(kinds, result.items);
      return pool.slice(0, count).map(item => ({
        label,
        name: displayName(item.node.name),
        file: short(item.node.file),
      }));
    });

  const demo = {
    repository: path.basename(repo),
    task,
    scannedFiles: result.discovery.scannedFiles,
    declarations: result.discovery.declarations,
    leads,
    passedOver,
    focus: { name: focus.node.name, file: short(focus.node.file), line: focus.node.startLine },
    edges,
    returned: {
      symbols: result.items.length,
      tokens: result.usedTokens,
      budget: result.tokenBudget,
      bodies: result.items.filter(item => item.level === 'body').length,
      signatures: result.items.filter(item => item.level === 'signature').length,
    },
    capturedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(path.join(dataDir, 'demo.json'), JSON.stringify(demo, null, 2) + '\n');
  console.log(`demo.json: ${leads.map(lead => lead.name).join(', ')} → ${edges.length} edges, ${demo.returned.symbols} symbols`);
}

// ---- metrics -------------------------------------------------------------------------------------------
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const readReport = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
const agent = readReport(path.join(projectRoot, 'benchmarks', 'results', 'agent', 'report.json'));
const retrieval = readReport(path.join(projectRoot, 'benchmarks', 'results', 'competitor', 'report.json'));
if (agent && retrieval) {
  // Agent context: total tokens a Claude Code session processed for the task, with no context tool vs with
  // JevTrace (told to call it first), median over the agent benchmark's tasks.
  const sessions = arm => agent.rows.filter(row => row.arm === arm);
  const without = sessions('baseline');
  const withJevtrace = sessions('jevtrace-guided');
  // Needed code found: share of each task's labelled declarations JevTrace delivered, mean over the tasks.
  const ours = retrieval.rows.filter(row => row.tool === 'jevtrace');
  const metrics = {
    agentTasks: withJevtrace.length,
    agentTokensWithout: Math.round(median(without.map(row => row.tokens.total))),
    agentTokensWith: Math.round(median(withJevtrace.map(row => row.tokens.total))),
    // Read, Grep and Glob calls inside the repository, median per task.
    searchesWithout: median(without.map(row => row.repoToolCalls)),
    searchesWith: median(withJevtrace.map(row => row.repoToolCalls)),
    recallTasks: ours.length,
    recall: Number((ours.reduce((sum, row) => sum + row.recall, 0) / ours.length * 100).toFixed(1)),
  };
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  console.log(`metrics.json: ${JSON.stringify(metrics)}`);
} else {
  console.log('Benchmark reports not found; metrics.json left as it is');
}
