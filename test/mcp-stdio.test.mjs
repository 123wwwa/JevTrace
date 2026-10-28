// End-to-end MCP check over real stdio: the server runs as a child process exactly as an MCP host starts it.
// Tests must never write to the real usage log in the home directory.
process.env.JEVTRACE_USAGE_LOG = 'off';
process.env.JEVTRACE_CONFIG = 'off';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const authProject = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] }),
  'src/token.ts': 'export function decodeJWT(token: string) { return token; }\n',
  'src/auth.ts': 'import { decodeJWT } from "./token";\nexport function refreshToken(token: string) { return decodeJWT(token); }\n',
};

/** Starts `node dist/cli.js --root <root>` offline and returns a connected client plus the server's stderr. */
async function connect(t, root, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--root', root],
    env: { ...getDefaultEnvironment(), JEVTRACE_JUDGE: 'include-all', JEVTRACE_USAGE_LOG: 'off', JEVTRACE_CONFIG: 'off', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const transportErrors = [];
  transport.onerror = error => transportErrors.push(error);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr, transportErrors };
}

const text = result => result.content.map(part => part.text ?? '').join('\n');
/** Result metadata: in `_meta`, out of the model's context. */
const view = result => result._meta?.['jevtrace/result'];

test('stdio server lists its tools and attaches no UI to them', async t => {
  const { client, transportErrors } = await connect(t, project(t, authProject));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['discover_entries', 'retrieve_dependency_context', 'retrieve_from_entry', 'usage_stats']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool._meta?.ui, undefined, tool.name);
  }
  assert.deepEqual(transportErrors, []);
});

test('usage_stats reports the usage log and this session only when asked', async t => {
  const root = project(t, authProject);
  const { client, transportErrors } = await connect(t, root, { JEVTRACE_USAGE_LOG: path.join(root, 'usage.jsonl'), CLAUDE_CONFIG_DIR: root });
  const empty = await client.callTool({ name: 'usage_stats', arguments: {} });
  assert.ok(!empty.isError, text(empty));
  assert.match(text(empty), /Tool calls: none recorded/);
  assert.match(text(empty), /This server session: no retrievals yet\./);

  await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'Fix refresh token validation' } });
  const stats = await client.callTool({ name: 'usage_stats', arguments: { days: 7 } });
  assert.match(text(stats), /JevTrace usage, last 7 days/);
  assert.match(text(stats), /Tool calls: 1 \(retrieve_dependency_context 1\)/);
  assert.match(text(stats), /This server session: [\d,]+ tokens of code sent across 1 retrieval, from files totalling [\d,]+ tokens read whole\. \(JevTrace considered [\d,]+ tokens of candidates; what it left out is not reading saved/);
  assert.match(text(stats), /tokens: [\d,]+ sent to the agent \([\d,]+ of them from files totalling [\d,]+ read whole\); [\d,]+ tokens of candidates considered/);
  assert.doesNotMatch(text(stats), /excluded/);
  assert.equal(stats.structuredContent.session.retrievals, 1);
  assert.deepEqual(transportErrors, []);
});

test('stdio server answers all three tools', async t => {
  const { client, transportErrors } = await connect(t, project(t, authProject));
  const retrieved = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'Fix refresh token validation' } });
  assert.ok(!retrieved.isError, text(retrieved));
  assert.ok(view(retrieved).items.some(item => item.node.name === 'refreshToken'));
  assert.match(text(retrieved), /Estimated context:/);

  const discovered = await client.callTool({ name: 'discover_entries', arguments: { task: 'refresh token' } });
  assert.ok(!discovered.isError, text(discovered));
  assert.ok(discovered.structuredContent.semanticLeads.length > 0);

  const explicit = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', line: 2 } });
  assert.ok(!explicit.isError, text(explicit));
  assert.equal(view(explicit).entry.name, 'refreshToken');

  const bySymbol = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', symbol: 'refreshToken' } });
  assert.ok(!bySymbol.isError, text(bySymbol));
  const byEvidence = await client.callTool({ name: 'retrieve_from_entry', arguments: {
    task: 'refresh token', evidence: { path: 'src/auth.ts', leads: [{ name: 'refreshToken', range: { startLine: 2, endLine: 2 }, score: 0.9 }] },
  } });
  assert.ok(!byEvidence.isError, text(byEvidence));
  assert.deepEqual(transportErrors, []);
});

test('invalid calls return errors and leave the server usable', async t => {
  const { client, transportErrors } = await connect(t, project(t, authProject));
  const failures = [
    ['retrieve_dependency_context', {}],
    ['retrieve_dependency_context', { task: '' }],
    ['retrieve_dependency_context', { task: 'x', tokenBudget: 10 }],
    ['retrieve_dependency_context', { task: 'x', maxLeads: 99 }],
    ['retrieve_from_entry', { task: 'x' }],
    ['retrieve_from_entry', { task: 'x', file: '../outside.ts', line: 1 }],
    ['retrieve_from_entry', { task: 'x', file: 'src/missing.ts', line: 1 }],
    ['retrieve_from_entry', { task: 'x', file: 'src/auth.ts', line: 999 }],
    ['retrieve_from_entry', { task: 'x', file: 'src/auth.ts', symbol: 'doesNotExist' }],
    ['discover_entries', { task: 'x', maxFiles: 0 }],
    ['no_such_tool', { task: 'x' }],
  ];
  for (const [name, args] of failures) {
    let outcome;
    try {
      const result = await client.callTool({ name, arguments: args });
      outcome = result.isError ? 'tool-error' : 'ok';
      assert.equal(outcome, 'tool-error', `${name} ${JSON.stringify(args)} should fail: ${text(result)}`);
      assert.ok(text(result).length > 0, `${name} error carries a message`);
    } catch (error) {
      // A protocol-level rejection (schema validation or unknown tool) is an acceptable failure too.
      assert.ok(error instanceof Error && error.message.length > 0, `${name} ${JSON.stringify(args)}`);
    }
  }
  const after = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.ok(!after.isError, 'server still serves after a burst of bad calls');
  assert.deepEqual(transportErrors, []);
});

test('concurrent calls are all answered', async t => {
  const { client } = await connect(t, project(t, authProject));
  const results = await Promise.all([
    client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } }),
    client.callTool({ name: 'discover_entries', arguments: { task: 'decode token' } }),
    client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', line: 2 } }),
    client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'decode jwt' } }),
  ]);
  for (const result of results) assert.ok(!result.isError, text(result));
});

test('a cancelled call does not break the server', async t => {
  const { client } = await connect(t, project(t, authProject));
  const controller = new AbortController();
  const pending = client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  const after = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.ok(!after.isError, text(after));
});

test('edge-case repositories produce answers or clear errors, never a dead server', async t => {
  const cases = {
    'no tsconfig': { 'lib/util.js': 'export function refreshToken(token) { return token.trim(); }\n' },
    'no source files': { 'README.md': '# empty\n' },
    'syntax error': { ...authProject, 'src/broken.ts': 'export function refreshBroken( {\n' },
    'invalid tsconfig': { 'tsconfig.json': '{ not json', 'src/auth.ts': 'export function refreshToken(token: string) { return token; }\n' },
  };
  for (const [label, files] of Object.entries(cases)) {
    const { client } = await connect(t, project(t, files));
    const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
    assert.ok(text(result).length > 0, `${label}: response has text`);
    const alive = await client.callTool({ name: 'discover_entries', arguments: { task: 'refresh token' } });
    assert.ok(alive.content.length > 0, `${label}: server still answers`);
  }
});

test('a root that does not exist refuses to start and says why on stderr', async () => {
  const missing = path.join(os.tmpdir(), `jevtrace-missing-${process.pid}-${Date.now()}`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--root', missing], env: { ...getDefaultEnvironment(), JEVTRACE_CONFIG: 'off' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  assert.match(stderr, /does not exist or is not a folder\. Check the --root you registered/);
});

test('a malformed tsconfig is skipped instead of breaking server startup', async t => {
  const { client } = await connect(t, project(t, { 'tsconfig.json': '{ not json', 'src/auth.ts': 'export function refreshToken(token: string) { return token; }\n' }));
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.ok(!result.isError, text(result));
  assert.ok(view(result).items.some(item => item.node.name === 'refreshToken'));
});

test('a missing provider key is reported as a tool error', async t => {
  const { client } = await connect(t, project(t, authProject), { JEVTRACE_JUDGE: '', OPENROUTER_API_KEY: '' });
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /API_KEY|key/i);
});

test('session savings accumulate across task-only retrievals and survive a no-context result', async t => {
  const { client } = await connect(t, project(t, authProject));
  const first = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token', tokenBudget: 500 } });
  const second = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'decode jwt', tokenBudget: 500 } });
  const [a, b] = [view(first).contextSavings, view(second).contextSavings];
  assert.equal(a.session.retrievals, 1);
  assert.equal(b.session.retrievals, 2);
  assert.equal(b.session.candidateTokens, a.candidateTokens + b.candidateTokens);
  assert.equal(b.session.savedTokens, a.savedTokens + b.savedTokens);
  assert.equal(b.session.returnedTokens, a.returnedTokens + b.returnedTokens);
  assert.equal(b.stage4Applied, false, 'the offline include-all judge ranks nothing');
  assert.doesNotMatch(text(second), /Session so far/, 'session totals are not for the agent');
  assert.match(text(second), /Estimated context: ~[\d,]+ tokens of code from 2 files \(those files read whole: ~[\d,]+ tokens\)\./);

  const explicit = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', line: 2 } });
  assert.equal(view(explicit).contextSavings, undefined, 'explicit-entry calls do not count toward session savings');

  const none = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'zzqx wobble frobnicate' } });
  assert.equal(view(none).status, 'incomplete');
  assert.equal(view(none).items, undefined);
  assert.equal(view(none).session.retrievals, 2);
});

test('without --root the server follows CLAUDE_PROJECT_DIR, as Claude Code user-scope servers need', async t => {
  const root = project(t, authProject);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    cwd: os.tmpdir(),
    env: { ...getDefaultEnvironment(), JEVTRACE_JUDGE: 'include-all', JEVTRACE_USAGE_LOG: 'off', JEVTRACE_CONFIG: 'off', CLAUDE_PROJECT_DIR: root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.ok(!result.isError, text(result));
  assert.ok(view(result).items.some(item => item.node.name === 'refreshToken'));
});

test('tool calls are logged locally and `jevtrace stats` summarizes them with Claude Code session use', async t => {
  const root = project(t, authProject);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-usage-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const logFile = path.join(scratch, 'usage.jsonl');
  const { client } = await connect(t, root, { JEVTRACE_USAGE_LOG: logFile });
  await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token', tokenBudget: 500 } });
  await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'zzqx wobble frobnicate' } });
  await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/missing.ts', line: 1 } });
  const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => [entry.tool, entry.outcome]), [
    ['retrieve_dependency_context', entries[0].outcome],
    ['retrieve_dependency_context', 'no-context'],
    ['retrieve_from_entry', 'error'],
  ]);
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].project, path.resolve(root));
  assert.ok(entries[0].candidateTokens >= entries[0].returnedTokens);

  // One session that used JevTrace and one that only searched.
  const claudeDir = path.join(scratch, 'claude');
  const sessionDir = path.join(claudeDir, 'projects', 'demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  const toolUse = name => JSON.stringify({ type: 'assistant', cwd: '/work/demo', message: { content: [{ type: 'tool_use', name, input: {} }] } });
  fs.writeFileSync(path.join(sessionDir, 'a.jsonl'), [toolUse('mcp__jevtrace__retrieve_dependency_context'), toolUse('Read')].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'b.jsonl'), [toolUse('Grep'), toolUse('Read')].join('\n'));
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, [cli, 'stats', '--days', '1'], { encoding: 'utf8',
    env: { ...process.env, JEVTRACE_USAGE_LOG: logFile, JEVTRACE_CONFIG: 'off', CLAUDE_CONFIG_DIR: claudeDir } });
  assert.match(output, /Tool calls: 3 \(retrieve_dependency_context 2, retrieve_from_entry 1\)/);
  assert.match(output, /failed: 1, no relevant code found: 1/);
  assert.match(output, /used JevTrace: 1/);
  assert.match(output, /searched with Grep\/Glob\/Read only: 1/);
});

test('the model gets only the maxChars-bounded text; dashboard data travels in _meta without source', async t => {
  const files = { ...authProject };
  for (let index = 0; index < 40; index++) files[`src/helper${index}.ts`] = `export function refreshHelper${index}(token: string) {\n${'  const padding = token + "' + 'x'.repeat(80) + '";\n'.repeat(1)}${Array.from({ length: 30 }, (_, line) => `  const step${line} = token.length + ${line};`).join('\n')}\n  return token;\n}\n`;
  const { client } = await connect(t, project(t, files));
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token helper', maxChars: 5000 } });
  assert.ok(!result.isError, text(result));
  assert.ok(text(result).length <= 5000);
  // Claude Code shows the model structuredContent in place of the text when present; the text alone reaches it.
  assert.equal(result.structuredContent, undefined);
  assert.ok(JSON.stringify(view(result)).length < 20_000, `the dashboard data was ${JSON.stringify(view(result)).length} chars`);
  assert.ok(!JSON.stringify(view(result)).includes('const step'), 'source code appears only in the bounded text');
  const discovered = await client.callTool({ name: 'discover_entries', arguments: { task: 'refresh token helper' } });
  assert.ok(text(discovered).length < 5_000);
  assert.match(text(discovered), /call retrieve_dependency_context for the code/);
});

test('started in the home directory, the server still connects and every tool explains how to fix it', async t => {
  // What a client passes when the agent was started outside any project. This used to crash the handshake
  // with a bare "Internal server error" (on macOS, EPERM from ~/Library) before any tool could answer.
  const { client, stderr } = await connect(t, os.homedir());
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'retrieve_dependency_context'));
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'Change how retry delays are computed' } });
  assert.equal(result.isError, true);
  assert.match(text(result), /started in your home directory .* not in a project/);
  assert.match(text(result), /--root \/path\/to\/project/);
  assert.match(stderr(), /jevtrace: JevTrace was started in your home directory/);
});

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('the server reports the package version', async t => {
  const { client } = await connect(t, project(t, authProject));
  assert.deepEqual(client.getServerVersion(), { name: 'jevtrace', version: packageVersion });
});

test('the CLI answers --help and --version, and names a mistyped command or option instead of starting a server', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = project(t, authProject);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: '', timeout: 30000,
    env: { ...getDefaultEnvironment(), JEVTRACE_USAGE_LOG: 'off', JEVTRACE_CONFIG: 'off' } });

  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.startsWith(`jevtrace ${packageVersion}:`), help.stdout);
  assert.match(help.stdout, /jevtrace setup/);
  assert.match(run('query', '--help').stdout, /Usage:/);
  assert.equal(run('--version').stdout.trim(), packageVersion);

  // These used to start the MCP server, which waited on stdin without a word.
  const typo = run('setpu');
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /unknown command "setpu"/);
  assert.match(typo.stderr, /Usage:/);
  const option = run('--rot', root);
  assert.equal(option.status, 1);
  assert.match(option.stderr, /Unknown option --rot\. Run `jevtrace --help`/);

  // A wrong value is the caller's to fix: it is named, not reported as a bug in JevTrace.
  const failures = [
    [['query', '--root', root, '--task', 'refresh token', '--offline', '--token-budget', 'abc'], /--token-budget needs a number, got "abc"/],
    [['query', '--root', root, '--task', 'refresh token', '--provider', 'nope'], /Unknown decision provider: nope \(available: /],
    [['query', '--root', root, '--task', 'refresh token', '--offline', '--tokn-budget', '900'], /Unknown option --tokn-budget for `jevtrace query`/],
    [['query', '--root', root, '--task', 'refresh token', '--offline', '--context-ranking', 'fast'], /--context-ranking must be one of jev, structural, got "fast"/],
    [['query', '--root', root, '--task', 'refresh token', '--offline', '--max-leads', '99'], /maxLeads must be between 1 and 8/],
    [['query', '--root', root, '--offline'], /needs --task, for example/],
    [['query', '--root', root, '--task', 'refresh token', '--offline', '--file', 'src/auth.ts'], /--file needs --line N or --symbol NAME/],
    [['query', '--root', root, '--task', 'refresh token', '--offline', '--evidence', path.join(root, 'missing.json')], /Cannot read the evidence file /],
    [['stats', '--days', 'soon'], /--days needs a number, got "soon"/],
  ];
  for (const [args, message] of failures) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    assert.doesNotMatch(result.stderr, /unexpected error/, args.join(' '));
  }
});

test('a wrong tool argument is explained as it is, not as an unexpected error to report', async t => {
  const { client } = await connect(t, project(t, authProject));
  const noEntry = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'x' } });
  assert.equal(text(noEntry), 'Provide an explicit file with line/symbol, or structured evidence with a lead');
  const missing = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'x', file: 'src/missing.ts', line: 1 } });
  assert.equal(text(missing), 'Entry file does not exist: src/missing.ts');
  const ambiguous = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'x', file: 'src/auth.ts', symbol: 'doesNotExist' } });
  assert.match(text(ambiguous), /^No declaration found at src\/auth\.ts:doesNotExist$/);
});

test('a rejected key is reported first, and a key saved by setup restarts the server behind the same connection', async t => {
  const http = await import('node:http');
  const keys = [];
  const provider = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      keys.push(request.headers.authorization);
      if (request.headers.authorization !== 'Bearer working-key') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(body).questions).map(id => [id, { noul: 0.9 }])) }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => provider.close());
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-config-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const configFile = path.join(scratch, 'config.json');
  const save = apiKey => fs.writeFileSync(configFile, JSON.stringify({ provider: 'custom', endpoint: `http://127.0.0.1:${provider.address().port}/v1/systemone`, apiKey }));

  save('expired-key');
  const { client, stderr } = await connect(t, project(t, authProject), { JEVTRACE_JUDGE: '', JEVTRACE_CONFIG: configFile });
  const call = () => client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'Fix refresh token validation' } });
  // The retrieval still answers from keyword leads; without the notice that looked like a working JevTrace.
  const rejected = await call();
  assert.ok(!rejected.isError, text(rejected));
  assert.match(text(rejected), /^Jev could not be used for this result, .* Tell the user: The Jev provider rejected the API key\. Run `npx -y jevtrace setup`/);
  assert.match(stderr(), /jevtrace \(retrieve_dependency_context\): Jev could not be used/);
  assert.ok(view(rejected).items.some(item => item.node.name === 'refreshToken'));

  // What `jevtrace setup` does while the agent keeps running.
  save('working-key');
  const accepted = await call();
  assert.ok(!accepted.isError, text(accepted));
  assert.doesNotMatch(text(accepted), /Jev could not be used/);
  assert.equal(keys.at(-1), 'Bearer working-key');
  assert.ok(keys.includes('Bearer expired-key'));
  assert.match(stderr(), /jevtrace: the saved provider settings changed; restarting the JevTrace server with them/);
  // A fresh process: the in-memory session totals start again from this call.
  const stats = await client.callTool({ name: 'usage_stats', arguments: {} });
  assert.match(text(stats), /This server session: [\d,]+ tokens of code sent across 1 retrieval\b/);
});

test('usage_stats and `stats` survive a damaged log and unreadable transcripts, and the tool bounds its scan', async t => {
  const root = project(t, authProject);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-stats-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // A log with a cut-off line and a record missing its fields, and a `projects` entry that is not a folder.
  const logFile = path.join(scratch, 'usage.jsonl');
  const entry = { time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: root, task: 'refresh token', ok: true, ms: 1200, outcome: 'complete' };
  fs.writeFileSync(logFile, [JSON.stringify(entry), '{"time":"2026-', JSON.stringify({ time: entry.time }), 'null', ''].join('\n'));
  const brokenClaude = path.join(scratch, 'broken');
  fs.mkdirSync(brokenClaude);
  fs.writeFileSync(path.join(brokenClaude, 'projects'), 'not a folder');
  const { client } = await connect(t, root, { JEVTRACE_USAGE_LOG: logFile, CLAUDE_CONFIG_DIR: brokenClaude });
  const stats = await client.callTool({ name: 'usage_stats', arguments: {} });
  assert.ok(!stats.isError, text(stats));
  assert.match(text(stats), /Tool calls: 1 \(retrieve_dependency_context 1\)/);
  assert.match(text(stats), /Claude Code sessions with code search: 0/);

  // Newest transcripts are read first; past the byte budget the rest are counted, not read.
  const { formatStats, scanClaudeSessions } = await import('../dist/stats.js');
  const claudeDir = path.join(scratch, 'claude');
  const sessionDir = path.join(claudeDir, 'projects', 'demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  const toolUse = name => JSON.stringify({ type: 'assistant', cwd: '/work/demo', message: { content: [{ type: 'tool_use', name, input: {} }] } });
  fs.writeFileSync(path.join(sessionDir, 'old.jsonl'), toolUse('Grep'));
  fs.writeFileSync(path.join(sessionDir, 'new.jsonl'), toolUse('mcp__jevtrace__retrieve_dependency_context'));
  fs.utimesSync(path.join(sessionDir, 'old.jsonl'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const env = { JEVTRACE_USAGE_LOG: 'off', CLAUDE_CONFIG_DIR: claudeDir };
  const newestSize = fs.statSync(path.join(sessionDir, 'new.jsonl')).size;
  const all = scanClaudeSessions(0, env);
  assert.deepEqual([all.sessions.map(session => path.basename(session.file)), all.unscanned], [['new.jsonl', 'old.jsonl'], 0]);
  const bounded = scanClaudeSessions(0, env, newestSize);
  assert.deepEqual([bounded.sessions.map(session => path.basename(session.file)), bounded.unscanned], [['new.jsonl'], 1]);
  assert.match(formatStats(1, env, newestSize), /1 older or unreadable session transcript was not scanned; `npx -y jevtrace stats --days 1` in a terminal reads them all\./);
  assert.doesNotMatch(formatStats(1, env), /not scanned/);
});


test('a task whose keywords occur nowhere gets that answer instead of an empty result', async t => {
  const { client } = await connect(t, project(t, authProject));
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'zzqx wobble frobnicate' } });
  assert.ok(!result.isError, text(result));
  assert.match(text(result), /No keyword match: none of the task's keywords \(zzqx, wobble, frobnicate\) appear/);
});


test('the supervisor restarts its worker between requests when the stamp changes, replaying the handshake', async t => {
  const { PassThrough } = await import('node:stream');
  const { superviseStdio } = await import('../dist/supervisor.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-supervisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A stand-in MCP server: answers with its pid and what it has seen of the handshake.
  const worker = path.join(dir, 'worker.mjs');
  fs.writeFileSync(worker, `
    let initialized = false, initializes = 0, buffer = '';
    const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('data', chunk => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf('\\n')) >= 0;) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.method === 'initialize') { initializes++; reply(message.id, { pid: process.pid }); }
        else if (message.method === 'notifications/initialized') initialized = true;
        else if (message.method === 'crash') process.exit(3);
        else if (message.method === 'hang') {}
        else if (message.id !== undefined) reply(message.id, { pid: process.pid, initialized, initializes });
      }
    });`);
  const input = new PassThrough();
  const output = new PassThrough();
  const logs = [];
  let stamp = 'a';
  const done = superviseStdio({ command: process.execPath, args: [worker], env: process.env, stamp: () => stamp, input, output, log: line => logs.push(line) });
  const received = [];
  const waiting = new Map();
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      received.push(message);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = method => new Promise(resolve => {
    const requestId = ++id;
    waiting.set(requestId, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method }) + '\n');
  });
  const notify = (method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');

  const first = (await request('initialize')).result.pid;
  notify('notifications/initialized');
  assert.deepEqual((await request('tools/call')).result, { pid: first, initialized: true, initializes: 1 });

  stamp = 'b';
  const restarted = (await request('tools/call')).result;
  assert.notEqual(restarted.pid, first, 'a new worker process');
  assert.equal(restarted.initialized, true, 'the handshake was replayed to it');
  assert.equal(restarted.initializes, 1);
  assert.deepEqual(received.map(message => message.id), [1, 2, 3], 'the replayed initialize is not answered to the host');
  assert.match(logs.join('\n'), /restarting the JevTrace server/);

  // Not while a request is open: its answer would be lost. A cancelled request is never answered, so it does not hold a restart back.
  const hanging = request('hang');
  stamp = 'c';
  assert.equal((await request('tools/call')).result.pid, restarted.pid);
  notify('notifications/cancelled', { requestId: 4 });
  const third = (await request('tools/call')).result.pid;
  assert.notEqual(third, restarted.pid);

  // A worker that dies answers its open request with an error; the next request starts a new one.
  const crashed = await request('crash');
  assert.match(crashed.error.message, /stopped before answering/);
  const fourth = (await request('tools/call')).result;
  assert.notEqual(fourth.pid, third);
  assert.equal(fourth.initialized, true);
  void hanging;

  input.end();
  assert.equal(await done, 0);
});
