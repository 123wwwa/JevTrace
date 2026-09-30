// End-to-end agent benchmark: the same coding agent answers the same question with and without a code-context
// MCP server.
//
//   baseline:        Claude Code with Read, Grep and Glob only.
//   jevtrace:        the same, plus the JevTrace MCP server; whether to use it is the agent's choice.
//   ttsc:            the same, plus @ttsc/graph (https://ttsc.dev) instead.
//   <tool>-guided:   the tool arm plus one system-prompt line of the kind a user puts in CLAUDE.md, saying to
//                    call that tool first when locating code (the same sentence for both tools).
//
// Every arm gets the identical task prompt. In a first run the agent with JevTrace available still chose
// Grep on a small repository, so the unguided arms measure adoption and the guided arms measure the effect.
// (ttsc's own benchmark keeps the prompt unguided and instead discards and retries graph-arm samples that
// made no MCP call; `invalidUnderTtscRule` marks those samples here.) Measured per session from Claude Code's
// stream-json output: tokens processed, tool calls, files read, tool output size, wall time and API cost;
// JevTrace's own Jev cost from its usage log; and answer correctness against the cases' labelled declarations.
//
//   node scripts/agent-benchmark.mjs [--cases id,id] [--arms baseline,jevtrace,...] [--model sonnet] [--repeat 1]
//     [--ttsc-dir DIR]   a directory with `ttsc`, `@ttsc/graph` and `typescript` installed (ttsc arms)
//     [--rescore]        recompute metrics from saved streams without running agents
//
// Requires the `claude` CLI signed in, the pinned checkouts (see benchmarks/*-cases.json) and a JevTrace
// provider (`node dist/cli.js setup` or .env). It spends real agent and Jev usage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const pilot = ['ky-retry-after', 'hono-token-clock-skew', 'hono-request-body-reuse', 'hono-thrown-http-response', 'jevgrep-cache-validation'];
const selected = arg('--cases', pilot.join(',')).split(',');
const arms = arg('--arms', 'baseline,jevtrace,jevtrace-guided').split(',');
const ttscDir = arg('--ttsc-dir');
const model = arg('--model', 'sonnet');
const repeat = Number(arg('--repeat', '1'));
const timeoutMs = Number(arg('--timeout-min', '15')) * 60_000;
const outRoot = path.join(projectRoot, 'benchmarks', 'results', 'agent');
const envFile = path.join(projectRoot, '.env');
const cli = path.join(projectRoot, 'dist', 'cli.js');

// ---- cases ---------------------------------------------------------------------------------------------
const cases = [];
for (const manifestFile of ['real-cases.json', 'holdout-cases.json']) {
  const manifestPath = path.join(projectRoot, 'benchmarks', manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const item of manifest.cases) {
    if (!selected.includes(item.id)) continue;
    cases.push({ ...item, root: path.resolve(path.dirname(manifestPath), manifest.repositories[item.repository].root) });
  }
}
cases.sort((a, b) => selected.indexOf(a.id) - selected.indexOf(b.id));
if (cases.length !== selected.length) throw new Error(`Unknown case in --cases: ${selected.filter(id => !cases.some(item => item.id === id)).join(', ')}`);

const prompt = task => [
  `Task: ${task}`,
  '',
  'Find the code in this repository that must be read or changed to do this task. Do not modify any files.',
  'End your answer with a section "Relevant declarations" listing each one on its own line as `path/to/file — symbolName`.',
].join('\n');

// ---- tools under test ----------------------------------------------------------------------------------
/**
 * The project config ttsc should graph. Hono's root tsconfig only lists references (`"files": []`), so its
 * graph is empty; the jevgrep package extends a workspace config that is not installed, which ttsc cannot
 * load, so it gets a standalone config over the same sources. JevTrace reads these repositories as they are.
 */
function ttscTsconfig(item) {
  if (item.repository === 'hono') return 'tsconfig.build.json';
  if (item.repository !== 'jevgrep') return undefined;
  const file = path.join(outRoot, 'ttsc-jevgrep-tsconfig.json');
  fs.writeFileSync(file, JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, rootDir: item.root },
    include: [item.root],
  }, null, 2));
  return file;
}

const tools = {
  jevtrace: {
    tool: 'mcp__jevtrace__retrieve_dependency_context',
    server: (item, dir) => ({ command: process.execPath, args: [...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []), cli, '--root', item.root], env: { JEVTRACE_USAGE_LOG: path.join(dir, 'jevtrace-usage.jsonl') } }),
  },
  ttsc: {
    tool: 'mcp__ttsc-graph__inspect_typescript_graph',
    server: item => {
      if (!ttscDir) throw new Error('--ttsc-dir is required for ttsc arms');
      const binary = path.join(ttscDir, 'node_modules', '@ttsc', `${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'ttscgraph.exe' : 'ttscgraph');
      const tsconfig = ttscTsconfig(item);
      return { command: process.execPath, args: [path.join(ttscDir, 'node_modules', '@ttsc', 'graph', 'lib', 'bin.js'), '--cwd', item.root, ...(tsconfig ? ['--tsconfig', tsconfig] : [])], env: { TTSC_GRAPH_BINARY: binary } };
    },
  },
};
const serverName = { jevtrace: 'jevtrace', ttsc: 'ttsc-graph' };
/**
 * jevgrep is a CLI with an agent skill rather than an MCP server; its README makes the skill part of the
 * setup, so every jevgrep arm gets the skill bundled with jevgrep 0.7.0 as its instructions. The agent may
 * run `jg` and nothing else in Bash; `jg` is benchmarks/competitor/agent-shim/jg, which runs the pinned
 * jevgrep image in Docker (jevgrep does not support Windows).
 */
const jevgrepSkill = path.join(projectRoot, 'benchmarks', 'competitor', 'skill', 'SKILL.md');
/** jevgrep's own skill file, taken from the pinned image on first use (it is not kept in this repository). */
function readJevgrepSkill() {
  if (!fs.existsSync(jevgrepSkill)) {
    const text = execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', 'jevtrace-bench-jevgrep:0.7.0',
      '/usr/local/lib/node_modules/@dzhng/jevgrep/dist/skills/jevgrep/SKILL.md'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    fs.mkdirSync(path.dirname(jevgrepSkill), { recursive: true });
    fs.writeFileSync(jevgrepSkill, text);
  }
  return fs.readFileSync(jevgrepSkill, 'utf8');
}
const shimDir = path.join(projectRoot, 'benchmarks', 'competitor', 'agent-shim');
const toolNames = ['jevtrace', 'ttsc', 'jevgrep'];
const toolOf = arm => toolNames.find(name => arm === name || arm === `${name}-guided`);
const guidance = tool => tool === 'jevgrep'
  ? 'This repository has the jevgrep CLI. To find the code a task needs, run `jg "<the task>" .` in Bash before using Grep, Glob or Read, then read only what its result did not cover.'
  : `This repository has the ${serverName[tool]} MCP server. To find the code a task needs, call ${tools[tool].tool} before using Grep, Glob or Read, then read only what its result did not cover.`;
const dotEnv = () => fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2].replace(/^"|"$/g, '')]))
  : {};

// ---- one session ---------------------------------------------------------------------------------------
function runSession(item, arm, run) {
  const dir = path.join(outRoot, item.id, `${arm}-${run}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) if (/usage\.jsonl$/.test(file)) fs.rmSync(path.join(dir, file));
  const tool = toolOf(arm);
  if (arm !== 'baseline' && !tool) throw new Error(`Unknown arm: ${arm}`);
  const cliTool = tool === 'jevgrep';
  const servers = tool && !cliTool ? { [serverName[tool]]: tools[tool].server(item, dir) } : {};
  const instructions = [
    ...(cliTool ? [readJevgrepSkill()] : []),
    ...(arm.endsWith('-guided') ? [guidance(tool)] : []),
  ].join('\n\n');
  const mcpConfig = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }, null, 2));
  const args = [
    '-p', prompt(item.task),
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    // Only what this harness passes: no user settings, hooks, plugins or other MCP servers.
    '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--tools', cliTool ? 'Read,Grep,Glob,Bash' : 'Read,Grep,Glob',
    '--allowedTools', 'Read', 'Grep', 'Glob', ...(tool && !cliTool ? [`mcp__${serverName[tool]}`] : []), ...(cliTool ? ['Bash(jg:*)', 'Bash(command -v jg)'] : []),
    ...(instructions ? ['--append-system-prompt', instructions] : []),
  ];
  const env = { ...process.env, JEVTRACE_USAGE_LOG: 'off' };
  if (cliTool) {
    Object.assign(env, {
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
      JG_SHIM_ROOT: item.root, JG_SHIM_OUT: dir, JG_SHIM_BENCH: path.join(projectRoot, 'benchmarks', 'competitor'),
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? dotEnv().OPENROUTER_API_KEY ?? '',
    });
  }
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn('claude', args, { cwd: item.root, shell: false, env });
    const stream = fs.createWriteStream(path.join(dir, 'stream.jsonl'));
    let stderr = '';
    child.stdout.pipe(stream);
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      stream.end(() => resolve({ dir, code, stderr, wallMs: performance.now() - started }));
    });
  });
}

// ---- metrics -------------------------------------------------------------------------------------------
const repoTools = new Set(['Read', 'Grep', 'Glob']);
// A jevgrep search, not `jg --version`, `jg doctor` or `jg files`.
const isJgSearch = command => /^\s*jg\s+(?!(?:--version|-v|--help|-h|doctor|files|auth|skill)\b)\S/.test(command);
const isToolCall = call => call.name.startsWith('mcp__') || (call.name === 'Bash' && isJgSearch(call.input?.command ?? ''));
function measure(item, arm, session) {
  const events = fs.readFileSync(path.join(session.dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = [];
  const resultChars = new Map();
  const resultText = new Map();
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use') calls.push({ id: block.id, name: block.name, input: block.input });
      if (event.type === 'user' && block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map(part => part.text ?? '').join('');
        resultChars.set(block.tool_use_id, text.length);
        resultText.set(block.tool_use_id, text);
      }
    }
  }
  const result = events.find(event => event.type === 'result') ?? {};
  const usage = result.usage ?? {};
  const answer = String(result.result ?? '');
  // Claude Code saves a very large tool result to a file outside the repository and the agent reads it back;
  // that is reading the tool's output (counted in tokens), not searching the repository.
  const inRepo = call => !path.relative(item.root, path.resolve(item.root, call.input?.file_path ?? call.input?.path ?? '.')).startsWith('..');
  // Claude Code runs read-only shell commands such as `grep` or `find` without approval, so in the jevgrep
  // arms (the only ones with Bash) those count as repository searches; `jg` itself and refused commands do not.
  const shellSearch = call => call.name === 'Bash' && !/^\s*(?:jg\b|command -v jg\b)/.test(call.input?.command ?? '')
    && !/requires approval|was blocked/.test(resultText.get(call.id) ?? '');
  const repoCalls = calls.filter(call => (repoTools.has(call.name) && inRepo(call)) || shellSearch(call));
  const filesRead = [...new Set(repoCalls.filter(call => call.name === 'Read').map(call => path.relative(item.root, path.resolve(item.root, call.input?.file_path ?? '')).replaceAll('\\', '/')))];
  const jevLines = fs.existsSync(path.join(session.dir, 'jevtrace-usage.jsonl'))
    ? fs.readFileSync(path.join(session.dir, 'jevtrace-usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  // jevgrep's provider usage, recorded per `jg` run by the shim's probe.
  const jgCost = fs.readdirSync(session.dir).filter(file => /^jg-\d+\.usage\.jsonl$/.test(file))
    .flatMap(file => fs.readFileSync(path.join(session.dir, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).usage?.cost ?? 0))
    .reduce((sum, cost) => sum + cost, 0);
  // A labelled declaration counts when the text names it (last name segment) and its file.
  // `#private` names start with a non-word character, so the boundary is placed after the `#`.
  const names = (text, target) => {
    const name = target.name.split('.').at(-1).replace(/^#/, '');
    return new RegExp(`(?:^|[^\\w$])#?${name.replace(/\$/g, '\\$')}\\b`).test(text) && text.includes(path.posix.basename(target.file));
  };
  const found = item.required.filter(target => names(answer, target));
  // The same check on the tool's first answer alone: which labelled declarations the tool itself pointed to,
  // before the agent did anything else. Comparable across tools that return code (JevTrace, jevgrep) and
  // tools that return locations only (ttsc). A result Claude Code saved to a file counts as the file's content.
  const firstCall = calls.find(isToolCall);
  let firstAnswer = firstCall ? resultText.get(firstCall.id) ?? '' : undefined;
  if (firstAnswer?.includes('<persisted-output>')) {
    // The whole output, whether or not the agent went on to read the file (it saw only a preview otherwise).
    const savedPath = /Full output saved to: (.+?\.txt)/.exec(firstAnswer)?.[1];
    if (savedPath && fs.existsSync(savedPath)) firstAnswer = fs.readFileSync(savedPath, 'utf8');
  }
  const firstFound = firstAnswer === undefined ? undefined : item.required.filter(target => names(firstAnswer, target)).length;
  return {
    case: item.id, repository: item.repository, arm, model,
    ok: session.code === 0 && result.subtype === 'success',
    tokens: {
      input: usage.input_tokens ?? 0, cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0,
      total: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
    toolOutputTokens: Math.round([...resultChars.values()].reduce((sum, chars) => sum + chars, 0) / 4),
    repoToolCalls: repoCalls.length,
    toolOutputReads: calls.filter(call => call.name === 'Read' && !inRepo(call)).length,
    // Calls of the tool under test: its MCP tool, or `jg` in Bash.
    mcpCalls: calls.filter(isToolCall).length,
    // ttsc publishes only tool-arm samples that called the tool at least once.
    invalidUnderTtscRule: arm !== 'baseline' && !calls.some(isToolCall),
    callsByTool: Object.fromEntries([...new Set(calls.map(call => call.name))].map(name => [name, calls.filter(call => call.name === name).length])),
    filesRead: filesRead.length,
    turns: result.num_turns ?? 0,
    wallSeconds: session.wallMs / 1000,
    apiCostUsd: result.total_cost_usd ?? 0,
    jevCostUsd: jevLines.reduce((sum, line) => sum + (line.jevCost ?? 0), 0) + jgCost,
    jevtraceOutcomes: jevLines.map(line => line.outcome),
    correctness: { found: found.length, required: item.required.length, missing: item.required.filter(target => !found.includes(target)).map(target => `${target.file} — ${target.name}`) },
    ...(firstFound === undefined ? {} : { toolFirstAnswer: { found: firstFound, required: item.required.length, tokens: Math.round(firstAnswer.length / 4) } }),
    ...(session.code === 0 ? {} : { error: session.stderr.slice(-500) }),
  };
}

// ---- run -----------------------------------------------------------------------------------------------
fs.mkdirSync(outRoot, { recursive: true });
const rows = [];
// --rescore recomputes metrics from the saved streams without running any agent.
const rescore = process.argv.includes('--rescore');
for (let run = 1; run <= repeat && rescore; run++) {
  for (const item of cases) for (const arm of arms) {
    const dir = path.join(outRoot, item.id, `${arm}-${run}`);
    const previous = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
    const row = { run, ...measure(item, arm, { dir, code: previous.ok ? 0 : 1, stderr: previous.error ?? '', wallMs: previous.wallSeconds * 1000 }) };
    rows.push(row);
    fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(row, null, 2));
  }
}
for (let run = 1; run <= repeat && !rescore; run++) {
  for (const item of cases) {
    // Rotate which arm goes first, so none always meets a cold cache.
    const shift = (cases.indexOf(item) + run) % arms.length;
    const order = [...arms.slice(shift), ...arms.slice(0, shift)];
    for (const arm of order) {
      process.stderr.write(`${item.id} / ${arm} / run ${run} ... `);
      const session = await runSession(item, arm, run);
      const row = { run, ...measure(item, arm, session) };
      rows.push(row);
      fs.writeFileSync(path.join(session.dir, 'metrics.json'), JSON.stringify(row, null, 2));
      process.stderr.write(`${row.ok ? 'ok' : 'FAILED'} ${Math.round(row.tokens.total / 1000)}k tokens, ${row.repoToolCalls} repo calls, ${row.mcpCalls} MCP calls, ${row.correctness.found}/${row.correctness.required} found, ${row.wallSeconds.toFixed(0)} s, $${row.apiCostUsd.toFixed(3)}\n`);
    }
  }
}

// The report covers every saved session of the selected cases, so arms run in separate invocations
// (e.g. ttsc added later) are compared on the same cases.
const allRows = cases.flatMap(item => {
  const caseDir = path.join(outRoot, item.id);
  return fs.existsSync(caseDir) ? fs.readdirSync(caseDir)
    .map(name => path.join(caseDir, name, 'metrics.json')).filter(file => fs.existsSync(file))
    .map(file => JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
});
const armOrder = ['baseline', 'jevtrace', 'jevtrace-guided', 'jevgrep', 'jevgrep-guided', 'ttsc', 'ttsc-guided'];
const reportArms = [...new Set(allRows.map(row => row.arm))].sort((a, b) => armOrder.indexOf(a) - armOrder.indexOf(b));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const summary = Object.fromEntries(reportArms.map(arm => {
  const armRows = allRows.filter(row => row.arm === arm);
  return [arm, {
    sessions: armRows.length,
    failed: armRows.filter(row => !row.ok).length,
    meanTotalTokens: Math.round(mean(armRows.map(row => row.tokens.total))),
    meanToolOutputTokens: Math.round(mean(armRows.map(row => row.toolOutputTokens))),
    meanRepoToolCalls: +mean(armRows.map(row => row.repoToolCalls)).toFixed(1),
    meanMcpCalls: +mean(armRows.map(row => row.mcpCalls)).toFixed(1),
    samplesWithoutMcpCall: armRows.filter(row => row.invalidUnderTtscRule).length,
    meanFilesRead: +mean(armRows.map(row => row.filesRead)).toFixed(1),
    meanTurns: +mean(armRows.map(row => row.turns)).toFixed(1),
    meanWallSeconds: +mean(armRows.map(row => row.wallSeconds)).toFixed(1),
    meanApiCostUsd: +mean(armRows.map(row => row.apiCostUsd)).toFixed(4),
    meanJevCostUsd: +mean(armRows.map(row => row.jevCostUsd)).toFixed(4),
    correctness: `${armRows.reduce((sum, row) => sum + row.correctness.found, 0)}/${armRows.reduce((sum, row) => sum + row.correctness.required, 0)}`,
    // Over sessions that called the tool: labelled declarations its first answer named, and that answer's size.
    toolFirstAnswer: armRows.some(row => row.toolFirstAnswer)
      ? `${armRows.reduce((sum, row) => sum + (row.toolFirstAnswer?.found ?? 0), 0)}/${armRows.reduce((sum, row) => sum + (row.toolFirstAnswer?.required ?? 0), 0)}`
      : undefined,
    meanToolFirstAnswerTokens: armRows.some(row => row.toolFirstAnswer)
      ? Math.round(mean(armRows.filter(row => row.toolFirstAnswer).map(row => row.toolFirstAnswer.tokens))) : undefined,
  }];
}));
fs.writeFileSync(path.join(outRoot, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), model, cases: selected, prompt: prompt('<task>'), guidance: Object.fromEntries(toolNames.map(tool => [tool, guidance(tool)])), summary, rows: allRows }, null, 2));
console.table(summary);
