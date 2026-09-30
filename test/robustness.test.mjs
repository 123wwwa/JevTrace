// Tests must never write to the real usage log in the home directory.
process.env.JEVTRACE_USAGE_LOG = 'off';
process.env.JEVTRACE_CONFIG = 'off';
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
  assert.match(result.notes.join('\n'), /reduced to signatures/, 'budget reductions are normal operation, reported as notes');
  assert.equal(result.status, 'complete', 'normal bounds do not mark a result incomplete');
});

test('compiler scans are cached per program and refreshed after edits; recent projects stay warm', t => {
  const root = project(t, { ...authFiles, 'ui/view.ts': 'import { decodeJWT } from "../src/token";\nexport function render(token: string) { return decodeJWT(token); }\n' });
  fs.writeFileSync(path.join(root, 'tsconfig.ui.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['ui'] }));
  const adapter = new TypeScriptAdapter(root);
  const lead = adapter.findEntry({ file: 'src/auth.ts', symbol: 'refreshToken' });
  let references = 0;
  const service = adapter['service'];
  const original = service.provideCallHierarchyIncomingCalls.bind(service);
  service.provideCallHierarchyIncomingCalls = (...args) => { references++; return original(...args); };
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

test('session savings total every retrieval and never count a larger result as negative savings', async () => {
  const { SessionSavings } = await import('../dist/context-metrics.js');
  const session = new SessionSavings();
  for (let index = 1; index <= 9; index++) session.record(100, 60);
  session.record(50, 80);
  const stats = session.snapshot();
  assert.deepEqual(stats, { retrievals: 10, candidateTokens: 950, returnedTokens: 620, savedTokens: 360, reductionPercent: 360 / 950 });
});

test('a decision provider with a different wire format plugs in through DecisionBackend alone', async t => {
  const { DecisionJudge } = await import('../dist/judges.js');
  const { postJson } = await import('../dist/decision-backends.js');
  const root = project(t, authFiles);
  // A made-up vendor: one POST with a flat `items` list, answers as `{ results: [{ id, p }] }`.
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const results = body.items.map(item => ({ id: item.id, p: /refresh|auth/i.test(JSON.stringify(item) + JSON.stringify(body.context)) ? 0.9 : 0.6 }));
    return new Response(JSON.stringify({ results, billing: { input_tokens: 1200, usd: 0.0005 } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const backend = {
    cacheKey: 'https://decisions.example.test/v1/evaluate',
    serialize: request => JSON.stringify({
      model: request.model,
      context: request.state,
      items: Object.entries(request.questions).map(([id, question]) => ({ id, prompt: question.instructions })),
    }),
    async decide(request, options) {
      const { data, attempts } = await postJson(this.cacheKey, { 'X-Api-Key': 'test' }, this.serialize(request), { ...options, label: 'Example decisions request' });
      return {
        answers: Object.fromEntries(data.results.map(result => [result.id, result.p])),
        usage: { inputTokens: data.billing.input_tokens, cost: data.billing.usd },
        attempts,
      };
    },
  };
  const judge = new DecisionJudge(backend, 'example-model', 0.5, 16, 'example-decisions');
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), judge, judge, 'refresh token', { contextRanking: 'structural' });
  assert.ok(result.items.some(item => item.node.name === 'refreshToken'));
  assert.equal(result.discovery.mode, 'parallel-jev');
  assert.ok(seen.length > 0 && seen.every(body => body.model === 'example-model' && Array.isArray(body.items)));
  const batch = result.discovery.judgeStats.batches.find(entry => !entry.cacheHit);
  assert.equal(batch.inputTokens, 1200);
  assert.equal(batch.cost, 0.0005);
});

test('reverse expansion finds callers of variable-held functions, private methods and default exports', t => {
  const root = project(t, {
    'src/middleware.ts': 'export const timeout = (ms: number) => async (next: () => Promise<void>) => { await next(); return ms; };\n',
    'src/app.ts': 'import { timeout } from "./middleware";\nexport function setup() { return timeout(10); }\n',
    'src/client.ts': 'export class Client {\n  async #retry(): Promise<number> { return this.#retryFromError(); }\n  async #retryFromError(): Promise<number> { return 1; }\n  run() { return this.#retry(); }\n}\n',
    'src/delay.ts': 'export default function delay(ms: number) { return ms; }\n',
    'src/use-delay.ts': 'import wait from "./delay";\nexport function pause() { return wait(5); }\n',
    'src/app.test.ts': 'import { timeout } from "./middleware";\ndeclare function it(name: string, body: () => void): void;\nit("applies the deadline", () => { timeout(1); });\n',
  });
  const adapter = new TypeScriptAdapter(root);
  const callers = (file, symbol) => adapter.reverseDependencies(adapter.findEntry({ file, symbol })).edges.map(edge => `${edge.kind}:${edge.target.name}`).sort();
  assert.deepEqual(callers('src/middleware.ts', 'timeout'), ['caller:setup', "test:it('applies the deadline') callback"]);
  assert.deepEqual(callers('src/client.ts', 'Client.#retryFromError'), ['caller:Client.#retry']);
  assert.deepEqual(callers('src/delay.ts', 'delay'), ['caller:pause']);
  const pause = adapter.findEntry({ file: 'src/use-delay.ts', symbol: 'pause' });
  assert.ok(adapter.dependencies(pause).edges.some(edge => edge.target.name === 'delay'), 'a default import is named after its declaration, not "default"');
});

test('callers reached through CommonJS module.exports and require are found, including renamed exports', t => {
  const root = project(t, {
    'src/retry.cjs': 'function retryDelay(n) { return n * 2; }\nmodule.exports = { retryDelay };\n',
    'src/backoff.cjs': 'function backoffDelay(n) { return n; }\nexports.delay = backoffDelay;\n',
    'src/run.cjs': 'const { retryDelay } = require("./retry.cjs");\nconst { delay } = require("./backoff.cjs");\nfunction go(n) { return retryDelay(n) + delay(n); }\nfunction unrelated(retryDelay) { return retryDelay; }\nmodule.exports = { go, unrelated };\n',
  });
  // A plain JavaScript project: no tsconfig, so every source is loaded with allowJs.
  fs.rmSync(path.join(root, 'tsconfig.json'));
  const adapter = new TypeScriptAdapter(root);
  const callers = (file, symbol) => adapter.reverseDependencies(adapter.findEntry({ file, symbol })).edges.map(edge => edge.target.name).sort();
  assert.deepEqual(callers('src/retry.cjs', 'retryDelay'), ['go'], 'a same-named parameter is not a use');
  assert.deepEqual(callers('src/backoff.cjs', 'backoffDelay'), ['go']);
});

test('formatted context never cuts a code block; blocks over maxChars are listed by location', async t => {
  const { formatContext } = await import('../dist/retrieve.js');
  const body = name => `export function ${name}() {\n${'  const value = 1;\n'.repeat(40)}}`;
  const item = (name, startLine) => ({ node: { id: name, name, file: 'src/a.ts', startLine, endLine: startLine + 41, source: body(name), signature: `export function ${name}()` }, level: 'body', path: [name], depth: 1 });
  const result = { task: 't', judge: 'j', status: 'complete', entry: item('lead', 1).node, items: ['lead', 'helper', 'caller', 'type'].map((name, index) => item(name, 1 + index * 50)),
    omitted: [], unresolved: [], considered: 4, usedTokens: 900, tokenBudget: 8000, visitPolicy: 'score', choiceDecisions: 0, wrapperLookahead: false,
    bodyThreshold: 0, omitThreshold: 0, reverseFanIn: 12, reversePruned: 0, judgeRounds: 0, judgeTrace: [], warnings: [] };
  const text = formatContext(result, 2500);
  assert.ok(text.length <= 2500);
  assert.ok(!text.includes('[Output character limit reached]'));
  assert.equal((text.match(/```ts/g) ?? []).length * 2, (text.match(/```/g) ?? []).length, 'every block is closed');
  assert.match(text, /## Not shown \(output limit/);
  assert.match(text, /- type — src\/a\.ts:151-192/);
});

test('callers of a function held in a class property are found although the call hierarchy skips that form', t => {
  const root = project(t, { 'src/request.ts': 'export class Req {\n  #cachedBody = (key: string) => key.length;\n  text() { return this.#cachedBody("text"); }\n  json() { return this.#cachedBody("json"); }\n}\n' });
  const adapter = new TypeScriptAdapter(root);
  const lead = adapter.findEntry({ file: 'src/request.ts', symbol: 'Req.#cachedBody' });
  assert.deepEqual(adapter.reverseDependencies(lead).edges.map(edge => edge.target.name).sort(), ['Req.json', 'Req.text']);
});

test('siblings: helpers the lead\'s same-file caller uses alongside it are included one step further', async t => {
  const root = project(t, {
    'src/source.ts': [
      'function sourceText(text: string) { return { lines: text.split("\\n") }; }',
      'export function textUnits(parsed: { lines: string[] }, max: number) { return parsed.lines.slice(0, max); }',
      'export function splitSource(text: string, max = 4) { return textUnits(sourceText(text), max); }',
      'export function unrelated() { return 1; }',
    ].join('\n'),
  });
  const onlyTextUnits = judge(node => node.id.startsWith('file::') || node.name === 'textUnits' ? 0.9 : 0.1);
  const result = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), onlyTextUnits, judge(), 'split text units', { contextRanking: 'structural' });
  const byName = new Map(result.items.map(item => [item.node.name, item]));
  assert.ok(byName.has('splitSource'), 'the caller is a direct neighbour');
  assert.equal(byName.get('sourceText')?.kind, 'sibling');
  assert.ok(!byName.has('unrelated'));
});

test('a project-wide task gets a repository map instead of arbitrary code; specific or unchecked tasks retrieve as before', async t => {
  const root = project(t, {
    'src/auth/token.ts': 'export function verifyToken(token: string) { return token.length > 0; }\nexport class TokenStore { get(key: string) { return key; } }\n',
    'src/http/router.ts': 'export function route(path: string) { return path; }\n',
    'src/http/router.test.ts': 'import { route } from "./router";\nexport function checkRoute() { return route("/"); }\n',
  });
  let discoverySignal;
  const scoped = specificity => judge(() => 0.9, {
    async judgeTaskScope() { return { specificity, stats: { batches: [{ candidates: 1, payloadBytes: 10, latencyMs: 1, cacheHit: false, attempts: 1, cost: 0.00001 }] } }; },
    async judgeFiles(_task, nodes, _context, signal) {
      discoverySignal = signal;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { decisions: new Map(nodes.map(node => [node.id, { include: true, score: 0.9 }])), stats: { batches: [] } };
    },
  });
  const run = (specificity, options = {}) => retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), scoped(specificity), judge(), 'verify token', { contextRanking: 'structural', ...options });

  const broad = await run(0.2);
  assert.equal(broad.status, 'broad');
  assert.equal(broad.specificity, 0.2);
  assert.ok(!('items' in broad));
  assert.match(broad.map, /src\/auth\/ — 1 file: verifyToken, TokenStore/);
  assert.match(broad.map, /src\/http\/ — 1 file: route/);
  assert.match(broad.map, /\+1 test files/);
  assert.match(broad.guidance, /scopeCheck: false/);
  // Two files are one area; the root descends into the only directory that holds them.
  assert.deepEqual(broad.subtasks.map(subtask => subtask.task), ['verify token — only in src/ (verifyToken, TokenStore, route)']);
  assert.ok(broad.guidance.includes('Suggested subtasks:\n- verify token — only in src/ (verifyToken'));
  assert.equal(discoverySignal?.aborted, true, 'discovery is stopped once the task is known to be project-wide');

  const specific = await run(0.8);
  assert.ok('items' in specific && specific.items.some(item => item.node.name === 'verifyToken'));
  assert.ok(specific.discovery.judgeStats.batches.some(batch => batch.cost === 0.00001), 'the scope question is billed with discovery');
  const unchecked = await run(0.2, { scopeCheck: false });
  assert.ok('items' in unchecked);

  const failing = judge(() => 0.9, { async judgeTaskScope() { throw new Error('provider down'); } });
  const degraded = await retrieveTaskContext(new RepositoryIndex(root), new TypeScriptAdapter(root), failing, judge(), 'verify token', { contextRanking: 'structural' });
  assert.ok('items' in degraded, 'a failed scope check falls back to retrieval');
  assert.ok(degraded.notes.some(note => /Task scope check failed/.test(note)));
});

test('the repository map merges directories into their parents until it fits', async t => {
  const root = project(t, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/features/f${i}/impl.ts`, `export function feature${i}() { return ${i}; }\n`])));
  const { repositoryMap, sourceInventory } = await import('../dist/broad-task.js');
  const inventory = sourceInventory(new RepositoryIndex(root));
  assert.equal(repositoryMap(inventory, 100_000).split('\n').length, 31);
  const merged = repositoryMap(inventory, 400);
  assert.ok(merged.length <= 400, merged);
  assert.match(merged, /src\/(features\/)? — 30 files: feature0/);
});

test('suggested subtasks split the largest area first and stop before fragmenting smaller ones', async t => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`src/core/c${i}.ts`] = `export function core${i}() { return ${i}; }\n`;
  for (let i = 0; i < 10; i++) files[`src/plugins/p${i}/index.ts`] = `export function plugin${i}() { return ${i}; }\n`;
  files['src/index.ts'] = 'export function main() { return 1; }\n';
  const root = project(t, files);
  const { sourceInventory, suggestSubtasks } = await import('../dist/broad-task.js');
  const inventory = sourceInventory(new RepositoryIndex(root));
  const areas = max => suggestSubtasks('fix bugs', inventory, max).map(subtask => `${subtask.area}:${subtask.files}`);
  // src (23 files) is split into core, plugins and its own index; plugins' ten one-file packages would exceed 6.
  assert.deepEqual(areas(6), ['src/ (files directly in it):1', 'src/core/:12', 'src/plugins/:10']);
  assert.equal(areas(16).length, 12, 'with room, the largest remaining area (plugins) is split too');
  assert.equal(suggestSubtasks('fix bugs', inventory, 6)[1].task, 'fix bugs — only in src/core/ (core0, core1, core10, core11)');
});

test('suggested subtasks split a flat source directory into runs of files', async t => {
  const files = {};
  for (let i = 0; i < 20; i++) files[`src/m${String(i).padStart(2, '0')}.ts`] = `export function mod${i}() { return ${i}; }\n`;
  const root = project(t, files);
  const { sourceInventory, suggestSubtasks } = await import('../dist/broad-task.js');
  const inventory = sourceInventory(new RepositoryIndex(root));
  // Without subdirectories, a single "only in src/" subtask would just repeat the task.
  const subtasks = suggestSubtasks('fix bugs', inventory, 8);
  assert.equal(subtasks.length, 8);
  assert.equal(subtasks.reduce((sum, subtask) => sum + subtask.files, 0), 20);
  assert.equal(subtasks[0].task, 'fix bugs — only in src/m00.ts, src/m01.ts (mod0, mod1)');
  assert.equal(suggestSubtasks('fix bugs', inventory, 30).length, 20, 'one file each when they fit');

  const small = sourceInventory(new RepositoryIndex(project(t, { 'src/a.ts': 'export function a() { return 1; }\n', 'src/b.ts': 'export function b() { return 2; }\n' })));
  assert.deepEqual(suggestSubtasks('fix bugs', small).map(subtask => subtask.area), ['src/'], 'a small directory stays whole');
});

test('the repository map lists directories JevTrace does not analyse, whatever the map budget', async t => {
  const root = project(t, {
    'src/a.ts': 'export function a() { return 1; }\n',
    'web/app.js': 'export function app() { return 1; }\n',
    'web/worker.js': 'export function worker() { return 1; }\n',
    'scripts/build.mjs': 'export function build() { return 1; }\n',
    'vite.config.ts': 'export default {};\n',
  });
  const { repositoryMap, sourceInventory } = await import('../dist/broad-task.js');
  const inventory = sourceInventory(new RepositoryIndex(root));
  const section = 'Not analysed by JevTrace (outside the TypeScript project; review these with Grep/Read, not JevTrace):\nscripts/ — 1 file\nweb/ — 2 files';
  assert.ok(repositoryMap(inventory, 100_000).endsWith(section));
  assert.ok(repositoryMap(inventory, 300).endsWith(section), 'the map shrinks, the list stays');
  assert.doesNotMatch(repositoryMap(inventory, 100_000), /vite\.config/, 'root files are tool configs, not listed');
});

test('large repositories: the discovery limit counts indexed files, a missing base config is tolerated, and a big unconfigured repository is scoped around the entry', t => {
  const root = project(t, {
    'src/a.ts': 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n',
    'src/b.ts': 'import { alpha } from "./a";\nexport function gamma() { return alpha(); }\n',
    'scripts/outside.ts': 'export function outside() { return 1; }\n',
  });
  // A workspace base config that is not installed.
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: '@org/tsconfig/base.json', include: ['src'] }));
  const scan = maxFiles => new RepositoryIndex(root).scan(maxFiles);
  const full = scan(100);
  assert.deepEqual([...new Set(full.nodes.map(node => node.file))].sort(), ['src/a.ts', 'src/b.ts'], 'the project include list still applies');
  assert.ok(full.warnings.some(warning => /1 project analysed without their base config, which was not found \(tsconfig\.json\)/.test(warning)));
  assert.equal(full.scannedFiles, 2, 'files outside every project do not count toward the limit');
  const limited = scan(1);
  assert.ok(limited.warnings.some(warning => /Discovery file limit reached \(1 source files\): src\/b\.ts and later paths/.test(warning)));
  const adapter = new TypeScriptAdapter(root);
  assert.deepEqual(adapter.reverseDependencies(adapter.findEntry({ file: 'src/a.ts', symbol: 'alpha' })).edges.map(edge => edge.target.name), ['gamma']);

  // No config and more than 5,000 sources: the program's roots are the entry's surroundings, not an error.
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-unconfigured-'));
  t.after(() => fs.rmSync(big, { recursive: true, force: true }));
  fs.mkdirSync(path.join(big, 'vendor'), { recursive: true });
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(big, 'vendor', `v${i}.js`), `export function v${i}() { return ${i}; }\n`);
  fs.mkdirSync(path.join(big, 'app'));
  fs.writeFileSync(path.join(big, 'app', 'due.js'), 'export function formatDue(date) { return String(date); }\n');
  fs.writeFileSync(path.join(big, 'app', 'notify.js'), 'import { formatDue } from "./due.js";\nexport function notify(card) { return formatDue(card.due); }\n');
  const scoped = new TypeScriptAdapter(big);
  const formatDue = scoped.findEntry({ file: 'app/due.js', symbol: 'formatDue' });
  assert.deepEqual(scoped.reverseDependencies(formatDue).edges.map(edge => edge.target.name), ['notify']);
});

test('Vue single-file components: script blocks are indexed at their own lines and linked to the TypeScript code they use', t => {
  const root = project(t, {
    'src/composables/useCounter.ts': 'export function useCounter(start: number) {\n  let n = start;\n  const inc = () => ++n;\n  return { n, inc };\n}\n',
    'src/components/Counter.vue': '<template>\n  <button @click="save">{{ n }}</button>\n</template>\n\n<script setup lang="ts">\nimport { useCounter } from "@/composables/useCounter";\nimport Child from "./Child.vue";\nconst { n, inc } = useCounter(1);\nfunction save() {\n  return inc();\n}\n</script>\n\n<style scoped>\n.a { color: red; }\n</style>\n',
    'src/components/Child.vue': '<template><p>{{ label() }}</p></template>\n<script>\nimport { useCounter } from "../composables/useCounter";\nexport default {\n  methods: {\n    label() { return useCounter(2).n; },\n  },\n};\n</script>\n',
  });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*'] }));
  const nodes = new RepositoryIndex(root).scan(100).nodes.map(node => `${node.file}:${node.name}@${node.startLine}`).sort();
  assert.deepEqual(nodes, ['src/components/Child.vue:label@6', 'src/components/Counter.vue:save@9', 'src/composables/useCounter.ts:useCounter@1']);
  const adapter = new TypeScriptAdapter(root);
  const callers = adapter.reverseDependencies(adapter.findEntry({ file: 'src/composables/useCounter.ts', symbol: 'useCounter' })).edges;
  assert.deepEqual(callers.map(edge => `${edge.target.name}@${edge.site.file}:${edge.site.line}`).sort(), [
    'Counter.vue <script setup>@src/components/Counter.vue:8',
    'label@src/components/Child.vue:6',
  ], 'top-level <script setup> calls belong to the component; a path alias resolves from inside a .vue file');
  const save = adapter.findEntry({ file: 'src/components/Counter.vue', symbol: 'save' });
  assert.equal(save.source, 'function save() {\n  return inc();\n}');
});

test('files under no config are searched without one; files a config owns but excludes are not', t => {
  const root = project(t, {
    'e2e/specs/login.ts': 'export function loginSpec() { return 1; }\n',
    'e2e/fixtures/ignored.ts': 'export function ignoredFixture() { return 1; }\n',
    'frontend/src/deal.js': 'export function updateProbability(status) { return status.length; }\n',
    'frontend/src/page.js': 'import { updateProbability } from "./deal.js";\nexport function onStatusChange(s) { return updateProbability(s); }\n',
  });
  fs.rmSync(path.join(root, 'tsconfig.json'));
  fs.writeFileSync(path.join(root, 'e2e', 'tsconfig.json'), JSON.stringify({ include: ['specs'] }));
  const files = [...new Set(new RepositoryIndex(root).scan(100).nodes.map(node => node.file))].sort();
  assert.deepEqual(files, ['e2e/specs/login.ts', 'frontend/src/deal.js', 'frontend/src/page.js']);
  const adapter = new TypeScriptAdapter(root);
  assert.deepEqual(adapter.reverseDependencies(adapter.findEntry({ file: 'frontend/src/deal.js', symbol: 'updateProbability' })).edges.map(edge => edge.target.name), ['onStatusChange']);
});

test('a clearly more relevant lead that overlaps an earlier one beats a diverse but weak lead', async t => {
  const root = project(t, {
    'src/request.ts': 'export class Req {\n  cache: Record<string, string> = {};\n  #cached(key: string) { return this.cache[key] ?? (this.cache[key] = key); }\n  text() { return this.#cached("text"); }\n}\n',
    'src/adapter.ts': 'export function createRequest(body: string) { return body.trim(); }\n',
  });
  const scores = { 'Req.#cached': 0.93, 'Req.text': 0.91, createRequest: 0.7 };
  const scored = judge(node => node.id.startsWith('file::') || node.id.startsWith('dir::') ? 0.9 : scores[node.name] ?? 0.1);
  const result = await discoverEntries(new RepositoryIndex(root), scored, 'reuse the cached body', { maxLeads: 2 }, new TypeScriptAdapter(root));
  assert.deepEqual(result.semanticLeads.map(lead => lead.name), ['Req.#cached', 'Req.text']);

  const adapter = new TypeScriptAdapter(root);
  const cached = adapter.findEntry({ file: 'src/request.ts', symbol: 'Req.#cached' });
  assert.deepEqual(adapter.dependencies(cached, { values: true }).edges.map(edge => `${edge.kind}:${edge.target.name}`), ['value:Req.cache'], 'the instance state a method works on');
  assert.deepEqual(adapter.dependencies(cached).edges, [], 'fields are followed only with values');
});
