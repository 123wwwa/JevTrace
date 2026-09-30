// Tests must never write to the real usage log in the home directory.
process.env.JEVTRACE_USAGE_LOG = 'off';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepositoryIndex, discoverEntries } from '../dist/discovery.js';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge, JevJudge } from '../dist/judges.js';
import { query } from '../dist/query.js';
import { retrieveTaskContext } from '../dist/task-pipeline.js';
import { scoreDiscovery, scoreRequiredContext } from '../dist/evaluate.js';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { createServer } from '../dist/server.js';
import { RetrievalLatencyWindow } from '../dist/context-metrics.js';

function semanticJudge({ fileScore = file => file.includes('auth') ? 0.9 : 0.8, symbolScore = name => name === 'refreshToken' ? 0.9 : 0.7 } = {}) {
  return {
    name: 'semantic-fixture',
    async judgeFiles(_task, nodes, context) {
      assert.match(context.tree, /src/);
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: fileScore(node.file) }])), stats: { batches: [] } };
    },
    async judgeEntries(_task, nodes) {
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: symbolScore(node.name) }])), stats: { batches: [] } };
    },
    async judge(_task, _entry, candidates) {
      return new Map(candidates.map(candidate => [candidate.node.id, { include: true, score: 0.9 }]));
    },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src'] }));
  fs.writeFileSync(path.join(root, 'src/token.ts'), 'export function decodeJWT(token: string) { return token; }\n');
  fs.writeFileSync(path.join(root, 'src/auth.ts'), 'import { decodeJWT } from "./token";\nexport function refreshToken(token: string) { return decodeJWT(token); }\n');
  fs.writeFileSync(path.join(root, 'ignored.ts'), 'export function refreshToken() { return "wrong project file"; }');
  return root;
}

test('repository discovery and compiler resolution support multiple named tsconfig projects', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'ui'));
  fs.writeFileSync(path.join(root, 'tsconfig.ui.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['ui'],
  }));
  fs.writeFileSync(path.join(root, 'ui/context-savings.ts'), 'import { decodeJWT } from "../src/token";\nexport function renderSavings(token: string) { return decodeJWT(token); }\n');

  const index = new RepositoryIndex(root);
  const inventory = index.scan(100);
  assert.ok(inventory.nodes.some(node => node.file === 'ui/context-savings.ts' && node.name === 'renderSavings'));
  assert.ok(!inventory.nodes.some(node => node.file === 'ignored.ts'));

  const adapter = new TypeScriptAdapter(root);
  const entry = adapter.findEntry({ file: 'ui/context-savings.ts', symbol: 'renderSavings' });
  assert.equal(entry.name, 'renderSavings');
  assert.ok(adapter.dependencies(entry).edges.some(edge => edge.target.name === 'decodeJWT'));
});

test('explicit entry resolution rejects missing files before TypeScript project loading', t => {
  const root = fixture(t);
  const adapter = new TypeScriptAdapter(root);
  assert.throws(() => adapter.findEntry({ file: 'src/does-not-exist.ts', line: 1 }), /Entry file does not exist/);
});

test('task-only query selects semantic leads independently of the lexical pool and follows typed imports', async t => {
  const root = fixture(t);
  const judge = semanticJudge();
  const result = await query(new RepositoryIndex(root), new TypeScriptAdapter(root), judge, 'Fix refresh token validation', undefined, { maxDepth: 1, reverse: false });
  assert.equal(result.discovery.selected.name, 'refreshToken');
  assert.equal(result.entry.file, 'src/auth.ts');
  assert.ok(result.items.some(item => item.node.name === 'decodeJWT'));
});

test('Jev file-tree discovery is not bounded by the lexical top-k pool', async t => {
  const root = fixture(t);
  const index = new RepositoryIndex(root);
  const lexicalTop = index.lexicalRank('refresh token', 1, 3000).candidates[0].node.name;
  const semanticTarget = lexicalTop === 'decodeJWT' ? 'refreshToken' : 'decodeJWT';
  const targetFileFragment = semanticTarget === 'decodeJWT' ? 'token' : 'auth';
  const judge = semanticJudge({
    fileScore: file => file.includes(targetFileFragment) ? 0.95 : 0.4,
    symbolScore: name => name === semanticTarget ? 0.95 : 0.2,
  });
  const result = await discoverEntries(index, judge, 'refresh token', { maxCandidates: 1, maxLeads: 1 }, new TypeScriptAdapter(root));
  assert.equal(result.lexicalCandidates.length, 1);
  assert.equal(result.lexicalCandidates[0].name, lexicalTop);
  assert.equal(result.semanticLeads[0].name, semanticTarget);
  assert.ok(!result.lexicalCandidates.some(lead => lead.name === semanticTarget));
});

test('pure Jev discovery can suppress lexical hints while keeping repository-tree discovery active', async t => {
  const root = fixture(t);
  const hintLengths = [];
  const judge = {
    name: 'no-hints-fixture',
    async judgeFiles(_task, nodes, context) {
      hintLengths.push(context.lexicalHints?.length ?? 0);
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: node.file.includes('token') ? 0.95 : 0.8 }])), stats: { batches: [] } };
    },
    async judgeEntries(_task, nodes) {
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: node.name === 'decodeJWT' ? 0.95 : 0.2 }])), stats: { batches: [] } };
    },
    async judge(_task, _entry, candidates) {
      return new Map(candidates.map(candidate => [candidate.node.id, { include: true, score: 0.9 }]));
    },
  };
  const result = await discoverEntries(new RepositoryIndex(root), judge, 'refresh token', { includeLexicalHints: false, maxLeads: 1 }, new TypeScriptAdapter(root));
  assert.equal(result.semanticLeads[0].name, 'decodeJWT');
  assert.equal(result.directoryJudgeStats.batches.length, 0);
  assert.equal(hintLengths.length, 1);
  assert.ok(hintLengths.every(length => length === 0));
});

test('task pipeline can isolate Jev leads without compiler expansion or lexical final merge', async t => {
  const root = fixture(t);
  const discoveryJudge = semanticJudge({
    fileScore: file => file.includes('token') ? 0.95 : 0.8,
    symbolScore: name => name === 'decodeJWT' ? 0.95 : 0.2,
  });
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), discoveryJudge, new IncludeAllJudge(),
    'Fix refresh token validation', {
      maxLeads: 1,
      includeCompilerExpansion: false,
      includeLexicalParallel: false,
      contextRanking: 'structural',
      tokenBudget: 8000,
    });
  assert.deepEqual(result.neighborhood.items.map(item => item.node.name), ['decodeJWT']);
  assert.deepEqual(result.rankingPool.items.map(item => item.node.name), ['decodeJWT']);
  assert.ok(!result.items.some(item => item.node.name === 'refreshToken'));
});

test('task pipeline keeps lexical retrieval as discovery guidance by default and supports explicit final merge', async t => {
  const root = fixture(t);
  const discoveryJudge = semanticJudge({
    fileScore: file => file.includes('token') ? 0.95 : 0.8,
    symbolScore: name => name === 'decodeJWT' ? 0.95 : 0.2,
  });
  const defaultResult = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), discoveryJudge, new IncludeAllJudge(),
    'Fix refresh token validation', { maxLeads: 1, contextRanking: 'structural', tokenBudget: 8000 });
  const mergedResult = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), discoveryJudge, new IncludeAllJudge(),
    'Fix refresh token validation', { maxLeads: 1, includeLexicalParallel: true, contextRanking: 'structural', tokenBudget: 8000 });
  assert.equal(defaultResult.rankingPool.stats.lexicalAdded, 0);
  assert.ok(defaultResult.rankingPool.items.every(item => !item.sources.includes('lexical')));
  assert.ok(mergedResult.rankingPool.items.some(item => item.sources.includes('lexical')));
});

test('task-only retrieval can recover the owning caller from a Jev-selected helper lead', async t => {
  const root = fixture(t);
  const judge = semanticJudge({
    fileScore: file => file.includes('token') ? 0.95 : 0.8,
    symbolScore: name => name === 'decodeJWT' ? 0.95 : name === 'refreshToken' ? 0.8 : 0.1,
  });
  const result = await query(new RepositoryIndex(root), new TypeScriptAdapter(root), judge, 'Fix refresh token validation', undefined,
    { maxDepth: 1, reverse: true, maxCandidates: 2, maxLeads: 1 });
  assert.equal(result.discovery.selected.name, 'decodeJWT');
  assert.equal(result.entry.name, 'decodeJWT');
  assert.ok(result.items.some(item => item.node.name === 'refreshToken' && item.kind === 'caller'));
});

test('task pipeline skips context Jev when the merged neighborhood already fits the final budget', async t => {
  const root = fixture(t);
  const discoveryJudge = semanticJudge({ symbolScore: name => name === 'refreshToken' ? 0.9 : 0.1 });
  const contextJudge = {
    name: 'must-not-run',
    async judge() { throw new Error('context judge should not run for a small neighborhood'); },
  };
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), discoveryJudge, contextJudge,
    'Fix refresh token validation', { tokenBudget: 8000, maxLeads: 1 });
  assert.equal(result.contextRankingApplied, false);
  assert.ok(result.neighborhood.stats.cappedTokens <= 8000);
});

test('task pipeline uses Jev scores only for ranking when the neighborhood exceeds budget', async t => {
  const root = fixture(t);
  const discoveryJudge = semanticJudge({ symbolScore: name => name === 'refreshToken' ? 0.9 : 0.1 });
  let judged = 0;
  const contextJudge = {
    name: 'ranking-fixture',
    async judgeWithStats(_task, _entry, candidates) {
      judged += candidates.length;
      return { decisions: new Map(candidates.map(candidate => [candidate.node.id, { include: false, score: 0.9 }])), stats: { batches: [] } };
    },
  };
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), discoveryJudge, contextJudge,
    'Fix refresh token validation', { tokenBudget: 30, perLeadTokenBudget: 1000, neighborhoodTokenBudget: 1000, maxLeads: 1 });
  assert.equal(result.contextRankingApplied, true);
  assert.ok(judged > 0);
  assert.ok(result.rankingPool.items.some(item => item.node.name === 'decodeJWT' && item.semanticScore === 0.9));
});

test('parallel discovery skips a redundant single-directory decision and reuses file/symbol answers', async t => {
  const root = fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.state.entry, undefined);
    assert.ok(body.state.candidates.every(item => !item.relationship));
    const filePass = typeof body.state.repositoryTree === 'string';
    assert.match(body.questions.candidate_0.instructions, filePass ? /repository (?:directory\/scope|file)/ : /semantic lead/);
    const answers = Object.fromEntries(body.state.candidates.map(candidate => {
      const name = candidate.candidate.name;
      const score = filePass
        ? name.includes('auth.ts') ? 0.9 : 0.8
        : name === 'refreshToken' ? 0.9 : 0.7;
      return [candidate.id, { noul: score }];
    }));
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  const index = new RepositoryIndex(root);
  const judge = new JevJudge('test', 'https://example.invalid');
  const adapter = new TypeScriptAdapter(root);
  const first = await discoverEntries(index, judge, 'refresh token', {}, adapter);
  const second = await discoverEntries(index, judge, 'refresh token', {}, adapter);
  assert.equal(first.selected.name, 'refreshToken');
  assert.equal(calls, 2);
  assert.equal(second.directoryJudgeStats.batches.length, 0);
  assert.equal(second.stageLatencyMs.directory, 0);
  assert.ok(second.fileJudgeStats.batches.every(batch => batch.cacheHit));
  assert.equal(second.symbolJudgeStats.batches[0].cacheHit, true);
});

test('no suitable semantic lead returns diagnostics without claiming a retrieval', async t => {
  const root = fixture(t);
  const judge = semanticJudge({ fileScore: () => 0.9, symbolScore: () => 0.1 });
  const result = await query(new RepositoryIndex(root), new TypeScriptAdapter(root), judge, 'render invoices');
  assert.equal(result.discovery.status, 'no-match');
  assert.equal(result.items, undefined);
  assert.equal(result.status, 'incomplete');
});

test('inventory notices added, edited and deleted files, including private methods', async t => {
  const root = fixture(t);
  const index = new RepositoryIndex(root);
  const adapter = new TypeScriptAdapter(root);
  adapter.findEntry({ file: 'src/auth.ts', line: 2 });
  assert.equal(index.scan(100).nodes.length, 2);
  const file = path.join(root, 'src/retry.ts');
  fs.writeFileSync(file, 'export class Client { #retry() { return 429; } }');
  const method = index.scan(100).nodes.find(node => node.name === 'Client.#retry');
  assert.ok(method);
  assert.equal(adapter.findEntry({ file: method.file, line: method.startLine, endLine: method.endLine }).name, 'Client.#retry');
  fs.writeFileSync(file, 'export function retryLater() { return 503; }');
  assert.ok(index.scan(100).nodes.some(node => node.name === 'retryLater'));
  fs.unlinkSync(file);
  assert.equal(index.scan(100).nodes.length, 2);
});

test('bounded discovery reports pruning and respects cancellation', async t => {
  const root = fixture(t);
  const index = new RepositoryIndex(root);
  const result = await discoverEntries(index, new IncludeAllJudge(), 'refresh token', { maxCandidates: 1 });
  assert.equal(result.leads.length, 1);
  assert.equal(result.status, 'incomplete');
  assert.match(result.warnings.join(' '), /Lexical RRF/);
  assert.ok(index.scan(1).warnings.length);
  await assert.rejects(discoverEntries(index, new IncludeAllJudge(), 'refresh', { signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(discoverEntries(index, new IncludeAllJudge(), 'refresh', { maxCandidates: NaN }), /maxCandidates/);
});

test('CLI accepts a task alone and preserves explicit entry mode', t => {
  const root = fixture(t);
  const args = ['dist/cli.js', 'query', '--root', root, '--task', 'refresh token', '--offline', '--max-depth', '1', '--no-reverse'];
  const discovered = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(discovered.discovery.mode, 'lexical');
  assert.equal(discovered.discovery.selected.name, discovered.discovery.lexicalCandidates[0].name);
  const explicit = JSON.parse(execFileSync(process.execPath, [...args, '--file', 'src/auth.ts', '--line', '2'], { encoding: 'utf8' }));
  assert.equal(explicit.discovery, undefined);
  assert.equal(explicit.entry.name, 'refreshToken');
});

test('retrieval latency window keeps a bounded rolling median and nearest-rank p95', () => {
  const window = new RetrievalLatencyWindow(5);
  for (const value of [10, 20, 30, 40, 50]) window.record(value);
  assert.deepEqual(window.snapshot(), { medianMs: 30, p95Ms: 50, sampleCount: 5, windowSize: 5 });
  assert.deepEqual(window.record(60), { medianMs: 40, p95Ms: 60, sampleCount: 5, windowSize: 5 });
  assert.throws(() => new RetrievalLatencyWindow(0), /positive integer/);
  assert.throws(() => window.record(-1), /non-negative finite/);
});

test('MCP exposes discovery and accepts task-only retrieval through its wire schema', async t => {
  const root = fixture(t);
  const previous = process.env.JEVTRACE_JUDGE;
  process.env.JEVTRACE_JUDGE = 'include-all';
  t.after(() => { if (previous === undefined) delete process.env.JEVTRACE_JUDGE; else process.env.JEVTRACE_JUDGE = previous; });
  const server = createServer(root);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(transport);
  await client.start();
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    client.onmessage = message => { if (message.id === requestId) message.error ? reject(new Error(message.error.message)) : resolve(message.result); };
    client.send({ jsonrpc: '2.0', id: requestId, method, params }).catch(reject);
  });
  await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await request('tools/list', {});
  assert.ok(listed.tools.some(tool => tool.name === 'discover_entries'));
  assert.ok(listed.tools.some(tool => tool.name === 'retrieve_from_entry'));
  const retrievalTool = listed.tools.find(tool => tool.name === 'retrieve_dependency_context');
  assert.equal(retrievalTool?._meta?.ui?.resourceUri, 'ui://jevtrace/context-savings-v2.html');
  assert.equal(retrievalTool?.inputSchema?.properties?.file, undefined);
  const resources = await request('resources/list', {});
  assert.ok(resources.resources.some(resource => resource.uri === 'ui://jevtrace/context-savings-v2.html'));
  assert.ok(resources.resources.some(resource => resource.uri === 'ui://jevtrace/context-savings.html'));
  const ui = await request('resources/read', { uri: 'ui://jevtrace/context-savings-v2.html' });
  assert.match(ui.contents[0].mimeType, /mcp-app/);
  assert.match(ui.contents[0].text, /JevTrace Context Savings/);
  const legacyUi = await request('resources/read', { uri: 'ui://jevtrace/context-savings.html' });
  assert.match(legacyUi.contents[0].mimeType, /mcp-app/);
  assert.match(legacyUi.contents[0].text, /JevTrace Context Savings/);
  const discovered = await request('tools/call', { name: 'discover_entries', arguments: { task: 'refresh token' } });
  assert.equal(discovered.isError, undefined);
  assert.equal(discovered.structuredContent.mode, 'lexical');
  assert.equal(discovered.structuredContent.selected.name, discovered.structuredContent.lexicalCandidates[0].name);
  const result = await request('tools/call', { name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent.items.some(item => item.node.name === 'decodeJWT'));
  assert.equal(result.structuredContent.contextSavings.estimated, true);
  assert.equal(result.structuredContent.contextSavings.available, true);
  assert.equal(result.structuredContent.contextSavings.candidateTokens, result.structuredContent.rankingPool.stats.tokens);
  assert.equal(result.structuredContent.contextSavings.returnedTokens, result.structuredContent.usedTokens);
  assert.equal(result.structuredContent.contextSavings.latencyStats.sampleCount, 1);
  assert.equal(result.structuredContent.contextSavings.latencyStats.windowSize, 50);
  assert.equal(result.structuredContent.contextSavings.latencyStats.p95Ms, result.structuredContent.contextSavings.totalMs);
  assert.match(result.content[0].text, /Estimated context:/);
  const second = await request('tools/call', { name: 'retrieve_dependency_context', arguments: { task: 'refresh token' } });
  assert.equal(second.structuredContent.contextSavings.latencyStats.sampleCount, 2);
  const explicit = await request('tools/call', { name: 'retrieve_from_entry', arguments: { task: 'refresh token', file: 'src/auth.ts', line: 2, maxDepth: 1, reverse: false } });
  assert.equal(explicit.isError, undefined);
  assert.equal(explicit.structuredContent.entry.name, 'refreshToken');
  assert.equal(explicit.structuredContent.contextSavings, undefined);
});

test('real-task metrics distinguish entry rank and missing required bodies', () => {
  const lead = { file: 'a.ts', line: 10, endLine: 20 };
  assert.deepEqual(scoreDiscovery({ selected: undefined, leads: [lead] }, [{ file: 'a.ts', line: 12 }]), {
    selectedHit: false, hitAt1: true, hitAt3: true, hitAt5: true, shortlistHit: true,
  });
  const gold = [{ file: 'a.ts', name: 'entry', line: 12, requiredLevel: 'body' }];
  const metrics = scoreRequiredContext({ items: [{ node: { file: 'a.ts', startLine: 10, endLine: 20 }, level: 'signature' }] }, gold);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.requiredLevelRecall, 0);
  assert.equal(scoreRequiredContext(undefined, gold).recall, 0);
});

test('config-free TS entry resolves extensionless imports', t => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, 'tsconfig.json'));
  const adapter = new TypeScriptAdapter(root);
  const entry = adapter.findEntry({ file: 'src/auth.ts', line: 2 });
  assert.ok(adapter.dependencies(entry).edges.some(edge => edge.target.name === 'decodeJWT'));
});
