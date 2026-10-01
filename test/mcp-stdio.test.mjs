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
  assert.match(text(stats), /This server session: [\d,]+ tokens excluded from [\d,]+ candidates across 1 retrieval /);
  assert.equal(stats.structuredContent.session.retrievals, 1);
  assert.deepEqual(transportErrors, []);
});

test('stdio server answers all three tools', async t => {
  const { client, transportErrors } = await connect(t, project(t, authProject));
  const retrieved = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'Fix refresh token validation' } });
  assert.ok(!retrieved.isError, text(retrieved));
  assert.ok(retrieved.structuredContent.items.some(item => item.node.name === 'refreshToken'));
  assert.match(text(retrieved), /Estimated context:/);

  const discovered = await client.callTool({ name: 'discover_entries', arguments: { task: 'refresh token' } });
  assert.ok(!discovered.isError, text(discovered));
  assert.ok(discovered.structuredContent.semanticLeads.length > 0);

  const explicit = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', line: 2 } });
  assert.ok(!explicit.isError, text(explicit));
  assert.equal(explicit.structuredContent.entry.name, 'refreshToken');

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
  assert.ok(result.structuredContent.items.some(item => item.node.name === 'refreshToken'));
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
  const [a, b] = [first.structuredContent.contextSavings, second.structuredContent.contextSavings];
  assert.equal(a.session.retrievals, 1);
  assert.equal(b.session.retrievals, 2);
  assert.equal(b.session.candidateTokens, a.candidateTokens + b.candidateTokens);
  assert.equal(b.session.savedTokens, a.savedTokens + b.savedTokens);
  assert.equal(b.session.returnedTokens, a.returnedTokens + b.returnedTokens);
  assert.equal(b.stage4Applied, false, 'the offline include-all judge ranks nothing');
  assert.match(text(second), /Session so far: .* across 2 retrievals/);

  const explicit = await client.callTool({ name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', line: 2 } });
  assert.equal(explicit.structuredContent.contextSavings, undefined, 'explicit-entry calls do not count toward session savings');

  const none = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'zzqx wobble frobnicate' } });
  assert.equal(none.structuredContent.status, 'incomplete');
  assert.equal(none.structuredContent.items, undefined);
  assert.equal(none.structuredContent.session.retrievals, 2);
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
  assert.ok(result.structuredContent.items.some(item => item.node.name === 'refreshToken'));
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

test('structured results stay small: source code is only in the maxChars-bounded text', async t => {
  const files = { ...authProject };
  for (let index = 0; index < 40; index++) files[`src/helper${index}.ts`] = `export function refreshHelper${index}(token: string) {\n${'  const padding = token + "' + 'x'.repeat(80) + '";\n'.repeat(1)}${Array.from({ length: 30 }, (_, line) => `  const step${line} = token.length + ${line};`).join('\n')}\n  return token;\n}\n`;
  const { client } = await connect(t, project(t, files));
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task: 'refresh token helper', maxChars: 5000 } });
  assert.ok(!result.isError, text(result));
  assert.ok(text(result).length <= 5000);
  // Claude Code shows the model structuredContent rather than the text, so the bounded context is there too.
  assert.equal(result.structuredContent.context, text(result));
  assert.ok(JSON.stringify(result.structuredContent).length < 5_000 + 20_000, `structuredContent was ${JSON.stringify(result.structuredContent).length} chars`);
  const outsideContext = JSON.stringify({ ...result.structuredContent, context: undefined });
  assert.ok(!outsideContext.includes('const step'), 'source code appears only inside the bounded context');
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
