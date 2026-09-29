import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RepositoryIndex, discoverEntries } from '../dist/discovery.js';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { JevJudge } from '../dist/judges.js';
import { retrieveTaskContext } from '../dist/task-pipeline.js';

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-robustness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const authFiles = {
  'src/token.ts': 'export function decodeJWT(token: string) { return token; }\n',
  'src/auth.ts': 'import { decodeJWT } from "./token";\nexport function refreshToken(token: string) { return decodeJWT(token); }\n',
};

/** A fixture judge: every node scores through `score(node)`; individual stages can be overridden. */
function judge(score = () => 0.9, overrides = {}) {
  const decide = nodes => ({ decisions: new Map(nodes.map(node => [node.id, { include: true, score: score(node) }])), stats: { batches: [] } });
  return {
    name: 'robustness-fixture',
    async judgeFiles(_task, nodes) { return decide(nodes); },
    async judgeEntries(_task, nodes) { return decide(nodes); },
    async judge(_task, _entry, candidates) { return decide(candidates.map(candidate => candidate.node)).decisions; },
    ...overrides,
  };
}

test('index only lists declarations the compiler adapter can resolve, including type-level declarations', t => {
  const root = project(t, {
    'src/model.ts': [
      'export interface RetryOptions { limit: number }',
      'export type Backoff = (attempt: number) => number;',
      'export enum Mode { Fast, Slow }',
      'export class LimitError extends Error { constructor(readonly limit: number) { super("limit"); } }',
      'export class Client { send() { return 1; } }',
      'export const retry = (options: RetryOptions) => options.limit;',
    ].join('\n'),
    'src/model.test.ts': 'declare function describe(name: string, body: () => void): void;\ndescribe("retry", () => {\n  const nestedHelper = () => 1;\n  nestedHelper();\n});\n',
  });
  const nodes = new RepositoryIndex(root).scan(100).nodes;
  const names = nodes.map(node => node.name);
  assert.ok(!names.includes('nestedHelper'), 'a variable inside a callback is not a resolvable lead');
  for (const name of ['RetryOptions', 'Backoff', 'Mode', 'LimitError', 'Client.send', 'retry']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('Client'), 'classes with indexed members are represented by their members');

  const adapter = new TypeScriptAdapter(root);
  for (const node of nodes) {
    assert.equal(adapter.findEntry({ file: node.file, line: node.startLine, endLine: node.endLine, symbol: node.name }).name, node.name);
  }
});

test('reverse expansion of a type-level lead finds the callables that use it', t => {
  const root = project(t, {
    'src/model.ts': 'export interface RetryOptions { limit: number }\n',
    'src/retry.ts': 'import type { RetryOptions } from "./model";\nexport function retryLimit(options: RetryOptions) { return options.limit; }\n',
  });
  const adapter = new TypeScriptAdapter(root);
  const lead = adapter.findEntry({ file: 'src/model.ts', symbol: 'RetryOptions' });
  assert.ok(adapter.reverseDependencies(lead).edges.some(edge => edge.target.name === 'retryLimit' && edge.kind === 'caller'));
});

test('an unresolvable semantic lead is skipped with a warning instead of failing retrieval', async t => {
  const root = project(t, { ...authFiles, 'src/session.ts': 'export function refreshSession(token: string) { return token.length; }\n' });
  const index = new RepositoryIndex(root);
  const adapter = new TypeScriptAdapter(root);
  const vanishing = judge(() => 0.9, {
    async judgeEntries(_task, nodes) {
      // The file disappears between discovery and compiler resolution.
      fs.unlinkSync(path.join(root, 'src/session.ts'));
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: node.name === 'refreshSession' ? 0.95 : 0.9 }])), stats: { batches: [] } };
    },
  });
  const result = await retrieveTaskContext(index, adapter, vanishing, vanishing, 'refresh token session', { contextRanking: 'structural' });
  assert.ok(result.items, 'the remaining leads still produce context');
  assert.ok(result.semanticLeads.length && !result.semanticLeads.some(node => node.name === 'refreshSession'));
  assert.match(result.warnings.join('\n'), /refreshSession\) could not be resolved/);
});

test('missing discovery answers score 0 with a warning instead of throwing', async t => {
  const root = project(t, authFiles);
  const partial = judge(() => 0.9, {
    async judgeEntries(_task, nodes) {
      return { decisions: new Map(nodes.filter(node => node.name === 'refreshToken').map(node => [node.id, { include: true, score: 0.9 }])), stats: { batches: [] } };
    },
  });
  const result = await discoverEntries(new RepositoryIndex(root), partial, 'refresh token');
  assert.equal(result.mode, 'parallel-jev');
  assert.deepEqual(result.semanticLeads.map(lead => lead.name), ['refreshToken']);
  assert.equal(result.leads.find(lead => lead.name === 'decodeJWT').score, 0);
  assert.match(result.warnings.join('\n'), /1 Jev discovery answers were missing or invalid/);
});

test('a failing discovery stage degrades to lexical leads', async t => {
  const root = project(t, authFiles);
  const failing = judge(() => 0.9, { async judgeFiles() { throw new Error('provider unavailable'); } });
  const result = await discoverEntries(new RepositoryIndex(root), failing, 'refresh token');
  assert.equal(result.mode, 'lexical');
  assert.ok(result.semanticLeads.some(lead => lead.name === 'refreshToken'));
  assert.match(result.warnings.join('\n'), /Jev discovery failed at file stage \(provider unavailable\)/);
  const aborted = judge(() => 0.9, { async judgeFiles() { throw new DOMException('aborted', 'AbortError'); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverEntries(new RepositoryIndex(root), aborted, 'refresh token', { signal: controller.signal }), /abort/i);
});

test('a failing context ranking under budget pressure falls back with a warning', async t => {
  const lines = (name, fill) => `  const ${name} = token + "${fill.repeat(60)}";\n`.repeat(40);
  const big = `export function refreshToken(token: string) {\n${lines('padding', 'x')}  return helper(token);\n}\nexport function helper(token: string) {\n${lines('more', 'y')}  return token;\n}\n`;
  const root = project(t, { 'src/auth.ts': big });
  const context = judge(() => 0.9, { async rankContext() { throw new Error('rate limited'); } });
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), judge(), context, 'refresh token',
    { tokenBudget: 1000, contextRanking: 'jev' });
  assert.equal(result.contextRankingApplied, false);
  assert.match(result.warnings.join('\n'), /Context ranking failed \(rate limited\); structural order was used/);
});

test('JevJudge leaves a malformed answer undecided instead of failing the batch', async t => {
  const root = project(t, authFiles);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 }, candidate_1: { noul: 7 } } }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const nodes = new RepositoryIndex(root).scan(100).nodes;
  const result = await new JevJudge('test-key').judgeEntries('refresh token', nodes);
  assert.equal(result.decisions.size, 1);
  assert.equal(result.stats.batches[0].invalidAnswers, 1);
});

function manyFiles(prefix, count, body = name => `export function ${name}() { return 1; }\n`) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const name = `${prefix.replace(/\W/g, '')}Item${index}`;
    return [`${prefix}/file${String(index).padStart(3, '0')}.ts`, body(name)];
  }));
}

test('small repositories are one directory scope, larger subtrees are split adaptively', async t => {
  const small = project(t, authFiles);
  let directoryCalls = 0;
  const counting = judge(() => 0.9, {
    async judgeFiles(_task, nodes) {
      if (nodes.some(node => node.id.startsWith('dir::'))) directoryCalls++;
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: 0.9 }])), stats: { batches: [] } };
    },
  });
  await discoverEntries(new RepositoryIndex(small), counting, 'refresh token');
  assert.equal(directoryCalls, 0);

  const large = project(t, { ...authFiles, ...manyFiles('src/billing', 40), ...manyFiles('src/shipping', 40) });
  const scopes = new RepositoryIndex(large).fileDiscoveryInventory(1000).directoryNodes.map(node => node.file).sort();
  assert.deepEqual(scopes, ['src', 'src/billing', 'src/shipping']);
});

test('the file cap keeps lexically strong files and lexical rescue overrides a lost directory decision', async t => {
  const root = project(t, {
    ...manyFiles('src/billing', 40),
    ...manyFiles('src/shipping', 40),
    'src/shipping/zz-refresh.ts': 'export function refreshToken(token: string) { return token; }\n',
  });
  const judgedFiles = [];
  const recording = rules => judge(() => 0.9, {
    async judgeFiles(_task, nodes) {
      if (!nodes[0].id.startsWith('dir::')) judgedFiles.push(...nodes.map(node => node.file));
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: rules(node) }])), stats: { batches: [] } };
    },
  });

  // The cap must drop weak files, not the alphabetically last one.
  await discoverEntries(new RepositoryIndex(root), recording(() => 0.9), 'refresh token', { maxJevFiles: 2, lexicalRescueFiles: 0 });
  assert.ok(judgedFiles.includes('src/shipping/zz-refresh.ts'));

  // The directory decision rejects the scope that holds the only lexical match; rescue still judges the file.
  judgedFiles.length = 0;
  const result = await discoverEntries(new RepositoryIndex(root),
    recording(node => node.file === 'src/shipping' ? 0 : node.file.endsWith('zz-refresh.ts') ? 0.95 : 0.5), 'refresh token');
  assert.deepEqual(result.rescuedFiles, ['src/shipping/zz-refresh.ts']);
  assert.ok(judgedFiles.includes('src/shipping/zz-refresh.ts'));
  assert.equal(result.selected.name, 'refreshToken');

  judgedFiles.length = 0;
  const pure = await discoverEntries(new RepositoryIndex(root), recording(node => node.file === 'src/shipping' ? 0 : 0.9), 'refresh token', { includeLexicalHints: false });
  assert.deepEqual(pure.rescuedFiles, [], 'the pure-Jev ablation has no lexical path at all');
});

test('final budget reduces large neighbours to signatures before omitting them', async t => {
  const padding = Array.from({ length: 60 }, (_, index) => `  const step${index} = input.length + ${index};`).join('\n');
  const root = project(t, {
    'src/auth.ts': 'import { normalizeToken } from "./normalize";\nexport function refreshToken(token: string) { return normalizeToken(token); }\n',
    'src/normalize.ts': `export function normalizeToken(input: string): string {\n${padding}\n  return input;\n}\n`,
  });
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), judge(node => node.id.startsWith('file::') || node.name === 'refreshToken' ? 0.95 : 0.2), judge(),
    'refresh token', { tokenBudget: 500, contextRanking: 'structural' });
  const normalize = result.items.find(item => item.node.name === 'normalizeToken');
  assert.equal(normalize?.level, 'signature');
  assert.ok(result.usedTokens <= 500);
  assert.match(result.warnings.join('\n'), /reduced to signatures/);
});

test('compiler scans are cached per program and refreshed after edits; recent projects stay warm', t => {
  const root = project(t, { ...authFiles, 'ui/view.ts': 'import { decodeJWT } from "../src/token";\nexport function render(token: string) { return decodeJWT(token); }\n' });
  fs.writeFileSync(path.join(root, 'tsconfig.ui.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['ui'] }));
  const adapter = new TypeScriptAdapter(root);
  const lead = adapter.findEntry({ file: 'src/auth.ts', symbol: 'refreshToken' });
  let references = 0;
  const service = adapter['service'];
  const original = service.findReferences.bind(service);
  service.findReferences = (...args) => { references++; return original(...args); };
  adapter.reverseDependencies(lead);
  const afterFirst = references;
  adapter.reverseDependencies(lead);
  assert.ok(afterFirst > 0);
  assert.equal(references, afterFirst, 'the second scan is served from the cache');

  adapter.findEntry({ file: 'ui/view.ts', symbol: 'render' });
  adapter.findEntry({ file: 'src/auth.ts', symbol: 'refreshToken' });
  assert.equal(adapter['service'], service, 'switching back reuses the warm language service');

  fs.writeFileSync(path.join(root, 'src/auth.ts'), 'import { decodeJWT } from "./token";\nexport function refreshToken(token: string) { return token.trim(); }\n');
  const edited = adapter.findEntry({ file: 'src/auth.ts', symbol: 'refreshToken' });
  assert.ok(!adapter.dependencies(edited).edges.some(edge => edge.target.name === 'decodeJWT'), 'an edit yields a fresh program and fresh scans');
});

test('type-level leads only fill lead slots that qualifying callables leave open', async t => {
  const callables = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map(name => [`src/${name}.ts`, `export function ${name}Refresh() { return 1; }\n`]));
  const root = project(t, { ...callables, 'src/model.ts': 'export interface RefreshOptions { limit: number }\n' });
  const scored = judge(node => node.name === 'RefreshOptions' ? 0.99 : 0.9);
  const full = await discoverEntries(new RepositoryIndex(root), scored, 'refresh');
  assert.equal(full.semanticLeads.length, 4);
  assert.ok(!full.semanticLeads.some(lead => lead.typeLevel));
  assert.ok(full.leads.find(lead => lead.name === 'RefreshOptions').typeLevel);

  const sparse = await discoverEntries(new RepositoryIndex(root), judge(node => node.name === 'RefreshOptions' || node.name === 'alphaRefresh' || node.id.startsWith('file::') ? 0.9 : 0.1), 'refresh');
  assert.deepEqual(sparse.semanticLeads.map(lead => lead.name), ['alphaRefresh', 'RefreshOptions']);
});

test('session savings keep an exact cumulative curve when thinned', async () => {
  const { SessionSavings } = await import('../dist/context-metrics.js');
  const session = new SessionSavings(4);
  for (let index = 1; index <= 9; index++) session.record(100, 60);
  const stats = session.snapshot();
  assert.equal(stats.retrievals, 9);
  assert.equal(stats.savedTokens, 360);
  assert.ok(stats.points.length <= 4);
  assert.deepEqual(stats.points.at(-1), [9, 900, 540], 'the latest point is always kept');
  for (const [retrieval, candidate, returned] of stats.points) assert.deepEqual([candidate, returned], [retrieval * 100, retrieval * 60]);
});
