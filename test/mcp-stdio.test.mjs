// End-to-end MCP check over real stdio: the server runs as a child process exactly as an MCP host starts it.
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
    env: { ...getDefaultEnvironment(), JEVTRACE_JUDGE: 'include-all', ...env },
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

test('stdio server lists its tools and UI resources', async t => {
  const { client, transportErrors } = await connect(t, project(t, authProject));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['discover_entries', 'retrieve_dependency_context', 'retrieve_from_entry']);
  for (const tool of tools) assert.equal(tool.inputSchema.type, 'object', tool.name);
  const { resources } = await client.listResources();
  for (const uri of ['ui://jevtrace/context-savings-v2.html', 'ui://jevtrace/context-savings.html']) {
    assert.ok(resources.some(resource => resource.uri === uri), uri);
    const read = await client.readResource({ uri });
    assert.match(read.contents[0].text, /JevTrace Context Savings/);
  }
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--root', missing], env: getDefaultEnvironment(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  assert.match(stderr, /project root is not a directory/);
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
