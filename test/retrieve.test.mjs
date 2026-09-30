// Tests must never read or write the real user config.
process.env.JEVTRACE_CONFIG = 'off';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge, JevJudge, OpenRouterJevJudge, createJudge } from '../dist/judges.js';
import { retrieve } from '../dist/retrieve.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');

test('resolves imported calls and expands dependencies only to depth two', async () => {
  const adapter = new TypeScriptAdapter(root);
  const result = await retrieve(adapter, new IncludeAllJudge(), 'Fix token validation', { file: 'src/auth.ts', line: 4 }, { maxDepth: 2, reverse: false });
  assert.deepEqual(result.items.map(item => item.node.name), ['refreshToken', 'verifyToken', 'TokenPayload', 'decodeJWT']);
  assert.equal(result.items[1].kind, 'import');
  assert.equal(result.items[2].depth, 2);
  assert.equal(result.items[3].depth, 2);
  assert.equal(result.items[1].node.file, 'src/jwt.ts');
  assert.equal(result.items[1].site.line, 4);
});

test('batches relevance judging once per dependency frontier', async () => {
  const calls = [];
  const judge = {
    name: 'frontier-batch',
    async judge(_task, _entry, candidates) {
      calls.push(candidates.map(candidate => candidate.node.name));
      return new Map(candidates.map(candidate => [
        candidate.node.id,
        { include: true, score: 0.9 },
      ]));
    },
  };

  const result = await retrieve(
    new TypeScriptAdapter(root),
    judge,
    'Change deep behavior',
    { file: 'src/chain.ts', line: 14 },
    { maxDepth: 2, reverse: false },
  );

  assert.equal(result.judgeRounds, 2);
  assert.equal(result.judgeTrace.length, 2);
  assert.deepEqual(result.judgeTrace.map(trace => trace.depth), [1, 2]);
  assert.deepEqual(result.judgeTrace.map(trace => trace.candidates), [2, 1]);
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls[0]), new Set(['wrapper', 'helper']));
  assert.deepEqual(calls[1], ['deep']);
});

test('collects same-file constants and types as bounded supporting context', () => {
  const adapter = new TypeScriptAdapter(root);
  const candidate = adapter.findEntry({ file: 'src/support-context.ts', line: 10 });
  const context = adapter.supportingContext(candidate);
  const names = new Set(context.map(item => item.name));
  assert.ok(names.has('defaultRetryOptions'));
  assert.ok(names.has('retryStatusCodes'));
  assert.ok(names.has('retryAfterStatusCodes'));
  assert.ok(context.length <= 6);
});

test('rejects an entry path outside the project', () => {
  assert.throws(() => new TypeScriptAdapter(root).findEntry({ file: '../outside.ts', line: 1 }), /inside project root/);
});

test('Jev judge maps native noul answers to inclusion decisions', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.questions.candidate_0.type, 'noul');
    assert.equal(request.state.task, 'Fix token validation');
    return new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    const judge = new JevJudge('test-key');
    const first = await judge.judgeWithStats('Fix token validation', entry, [candidate]);
    assert.deepEqual(first.decisions.get(entry.id), { include: true, score: 0.8 });
    assert.equal(first.stats.batches.length, 1);
    assert.equal(first.stats.batches[0].candidates, 1);
    assert.ok(first.stats.batches[0].payloadBytes > 0);
    assert.equal(first.stats.batches[0].cacheHit, false);
    assert.equal(first.stats.batches[0].attempts, 1);
    const second = await judge.judgeWithStats('Fix token validation', entry, [candidate]);
    assert.equal(second.stats.batches[0].cacheHit, true);
    assert.equal(second.stats.batches[0].attempts, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev payload includes entry body and relationship metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.match(request.state.entry.signature, /retryDelay/);
    assert.match(request.state.entry.source, /normalizeRetryOptions/);
    assert.equal(request.state.candidates[0].relationship.kind, 'call');
    assert.equal(request.state.candidates[0].candidate.name, 'normalizeRetryOptions');
    const supportNames = new Set(request.state.candidates[0].candidate.supportingContext.map(item => item.name));
    assert.ok(supportNames.has('defaultRetryOptions'));
    assert.ok(supportNames.has('retryAfterStatusCodes'));
    return new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 } } }), { status: 200 });
  };
  try {
    const adapter = new TypeScriptAdapter(root);
    const entry = adapter.findEntry({ file: 'src/support-context.ts', line: 14 });
    const dependency = adapter.dependencies(entry).edges.find(edge => edge.target.name === 'normalizeRetryOptions');
    assert.ok(dependency);
    const candidate = {
      node: dependency.target,
      kind: dependency.kind,
      from: entry.id,
      depth: 1,
      site: dependency.site,
      supportingContext: adapter.supportingContext(dependency.target),
    };
    const result = await new JevJudge('test-key').judge('Inspect option handling', entry, [candidate]);
    assert.deepEqual(result.get(dependency.target.id), { include: true, score: 0.8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('no provider is a default: one provider key in the environment selects it; none or several ask for setup', async () => {
  assert.equal(createJudge({ JEVTRACE_CONFIG: 'off', OPENROUTER_API_KEY: 'test-key' }).name, 'openrouter-jev');
  assert.equal(createJudge({ JEVTRACE_CONFIG: 'off', OPENCODE_API_KEY: 'test-key' }).name, 'opencode-jev');
  assert.throws(() => createJudge({ JEVTRACE_CONFIG: 'off' }), /No decision provider is configured\. Run `npx -y jevtrace setup`/);
  assert.throws(() => createJudge({ JEVTRACE_CONFIG: 'off', OPENROUTER_API_KEY: 'a', TYPESAFE_API_KEY: 'b' }), /Several provider keys are set \(OPENROUTER_API_KEY, TYPESAFE_API_KEY\)/);
  assert.equal(createJudge({ JEVTRACE_CONFIG: 'off', OPENROUTER_API_KEY: 'a', TYPESAFE_API_KEY: 'b', JEVTRACE_PROVIDER: 'typesafe' }).name, 'typesafe-jev');
});

test('OpenRouter maps noul probabilities', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(request.model, 'typesafe/jev-1.13');
    assert.equal(request.questions.candidate_0.type, 'noul');
    return new Response(JSON.stringify({ answers: { candidate_0: { type: 'noul', noul: 0.8 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    const decisions = await new OpenRouterJevJudge('test-key').judge('Fix token validation', entry, [candidate]);
    assert.deepEqual(decisions.get(entry.id), { include: true, score: 0.8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selects TypeSafe, Vercel, and custom System One providers with model overrides', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    seen.push({ url: String(url), model: request.model, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };

    await createJudge({ JEVTRACE_CONFIG: 'off', TYPESAFE_API_KEY: 'ts-key', JEVTRACE_PROVIDER: 'typesafe' }).judge('Fix token validation', entry, [candidate]);
    await createJudge({ JEVTRACE_CONFIG: 'off', AI_GATEWAY_API_KEY: 'vercel-key', JEVTRACE_PROVIDER: 'vercel', JEVTRACE_MODEL: 'typesafe-ai/jev-custom' }).judge('Fix token validation', entry, [candidate]);
    await createJudge({ JEVTRACE_CONFIG: 'off', OPENCODE_API_KEY: 'zen-key', JEVTRACE_PROVIDER: 'opencode', JEVTRACE_MODEL: 'jev-1.13-free' }).judge('Fix token validation', entry, [candidate]);
    await createJudge({ JEVTRACE_CONFIG: 'off', JEVTRACE_PROVIDER: 'custom', JEVTRACE_ENDPOINT: 'http://localhost:8787/v1/systemone', JEVTRACE_MODEL: 'local-jev' }).judge('Fix token validation', entry, [candidate]);

    assert.deepEqual(seen, [
      { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', authorization: 'Bearer ts-key' },
      { url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev-custom', authorization: 'Bearer vercel-key' },
      { url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', authorization: 'Bearer zen-key' },
      { url: 'http://localhost:8787/v1/systemone', model: 'local-jev', authorization: undefined },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev retries a transient provider response once', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('', { status: 503, headers: { 'retry-after': '0' } })
      : new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.4 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    const result = await new OpenRouterJevJudge('test-key').judge('Fix token validation', entry, [candidate]);
    assert.equal(calls, 2);
    assert.deepEqual(result.get(entry.id), { include: false, score: 0.4 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev retries Cloudflare-style transient 520 responses once', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('HTTP 520: error code: 520', { status: 520 })
      : new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    const result = await new OpenRouterJevJudge('test-key').judge('Fix token validation', entry, [candidate]);
    assert.equal(calls, 2);
    assert.deepEqual(result.get(entry.id), { include: true, score: 0.8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev preserves provider details for payment and spending-limit errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: 'Insufficient credits or key limit reached',
      metadata: { limit_source: 'openrouter_key_limit' },
    },
  }), { status: 402, statusText: 'Payment Required' });
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    await assert.rejects(
      () => new OpenRouterJevJudge('test-key').judge('Fix token validation', entry, [candidate]),
      /Jev request failed \(402\): Insufficient credits or key limit reached \[limit_source=openrouter_key_limit\]/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev retries a provider timeout once', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    const result = await new OpenRouterJevJudge('test-key').judge('Fix token validation', entry, [candidate]);
    assert.equal(calls, 2);
    assert.deepEqual(result.get(entry.id), { include: true, score: 0.8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev caps concurrent provider calls at four', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  globalThis.fetch = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return new Response(JSON.stringify({ answers: { candidate_0: { noul: 0.8 } } }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidate = { node: entry, kind: 'call', from: entry.id, depth: 1, site: { file: 'src/auth.ts', line: 4 } };
    const judge = new JevJudge('test-key');
    await Promise.all(Array.from({ length: 6 }, (_, index) => judge.judge(`task ${index}`, entry, [candidate])));
    assert.equal(peak, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev evaluates wide frontiers in parallel batches of sixteen', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const request = JSON.parse(options.body);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    const answers = Object.fromEntries(
      Object.keys(request.questions).map(name => [name, { noul: 0.8 }]),
    );
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidates = Array.from({ length: 33 }, (_, index) => ({
      node: { ...entry, id: `candidate-${index}`, name: `candidate${index}` },
      kind: 'call',
      from: entry.id,
      depth: 1,
      site: { file: 'src/auth.ts', line: 4 },
    }));
    const result = await new JevJudge('test-key').judge('wide frontier', entry, candidates);
    assert.equal(calls, 3);
    assert.equal(peak, 3);
    assert.equal(result.size, 33);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev supports configurable provider batch sizes', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const request = JSON.parse(options.body);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    const answers = Object.fromEntries(
      Object.keys(request.questions).map(name => [name, { noul: 0.8 }]),
    );
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  try {
    const entry = new TypeScriptAdapter(root).findEntry({ file: 'src/auth.ts', line: 4 });
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      node: { ...entry, id: `small-batch-${index}`, name: `smallBatch${index}` },
      kind: 'call',
      from: entry.id,
      depth: 1,
      site: { file: 'src/auth.ts', line: 4 },
    }));
    const result = await new OpenRouterJevJudge('test-key', 'typesafe/jev-1.13', 2)
      .judgeWithStats('small batches', entry, candidates);
    assert.equal(calls, 3);
    assert.equal(peak, 3);
    assert.deepEqual(result.stats.batches.map(batch => batch.candidates), [2, 2, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jev Choice selects one offered next-visit candidate', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.questions.next.type, 'choice');
    assert.equal(Object.keys(request.questions.next.criteria).length, 2);
    return new Response(JSON.stringify({ answers: { next: { type: 'choice', choice: 'candidate_1' } } }), { status: 200 });
  };
  try {
    const adapter = new TypeScriptAdapter(root);
    const entry = adapter.findEntry({ file: 'src/chain.ts', line: 14 });
    const candidates = adapter.dependencies(entry).edges.map(edge => ({ ...edge, node: edge.target, from: entry.id, depth: 1 }));
    const selected = await new OpenRouterJevJudge('test-key').chooseNext('Change behavior', entry, candidates);
    assert.equal(selected, candidates[1].node.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Choice visit policy changes queue selection while keeping Noul scores', async () => {
  let chosen = 0;
  const judge = {
    name: 'fixture-choice',
    async judge(_task, _entry, candidates) {
      return new Map(candidates.map(candidate => [candidate.node.id, { score: 0.9, include: true }]));
    },
    async chooseNext(_task, _entry, candidates) {
      chosen++;
      return candidates.at(-1).node.id;
    },
  };
  const result = await retrieve(new TypeScriptAdapter(root), judge, 'Change behavior',
    { file: 'src/chain.ts', line: 14 }, { reverse: false, maxDepth: 1, visitPolicy: 'choice' });
  assert.ok(chosen > 0);
  assert.equal(result.visitPolicy, 'choice');
  assert.ok(result.choiceDecisions > 0);
});

test('caps one-hop reverse fan-in and keeps task-related callers first', async () => {
  const entry = { id: 'entry', name: 'helper', file: 'src/helper.ts', startLine: 1, endLine: 1, source: 'export function helper() {}', signature: 'export function helper()' };
  const caller = name => ({ id: name, name, file: `src/${name}.ts`, startLine: 1, endLine: 1, source: `export function ${name}() { helper(); }`, signature: `export function ${name}()` });
  const callers = ['genericCaller', 'paymentFlow', 'timeoutFlow', 'paymentTimeoutFlow', 'otherCaller'].map(caller);
  const adapter = {
    language: 'test',
    findEntry: () => entry,
    dependencies: () => ({ edges: [], unresolved: [] }),
    reverseDependencies: node => node.id === entry.id ? {
      edges: callers.map(target => ({ kind: 'caller', target, site: { file: target.file, line: 1, text: target.source } })),
      unresolved: [],
    } : { edges: [], unresolved: [] },
  };
  const result = await retrieve(adapter, new IncludeAllJudge(), 'Fix payment timeout behavior', { file: entry.file, line: 1 },
    { maxDepth: 1, reverse: true, reverseFanIn: 2 });
  assert.equal(result.reverseFanIn, 2);
  assert.equal(result.reversePruned, 3);
  assert.deepEqual(new Set(result.items.slice(1).map(item => item.node.name)), new Set(['paymentTimeoutFlow', 'paymentFlow']));
  assert.match(result.warnings.join(' '), /reverseFanIn=2/);
});

test('finds a caller through an imported function reference', () => {
  const adapter = new TypeScriptAdapter(root);
  const entry = adapter.findEntry({ file: 'src/jwt.ts', line: 7 });
  const reverse = adapter.reverseDependencies(entry);
  assert.ok(reverse.edges.some(edge => edge.target.name === 'refreshToken' && edge.kind === 'caller'));
});

test('finds a direct test caller and preserves its call site', () => {
  const adapter = new TypeScriptAdapter(root);
  const entry = adapter.findEntry({ file: 'src/auth.ts', line: 4 });
  const reverse = adapter.reverseDependencies(entry);
  assert.deepEqual(reverse.edges.map(edge => edge.target.name), ['testRefresh']);
  assert.equal(reverse.edges[0].kind, 'test');
  assert.equal(reverse.edges[0].site.file, 'src/auth.test.ts');
});

test('uses 0.3/0.3 as the default relevance policy', async () => {
  const judge = {
    name: 'default-thresholds',
    async judge(_task, _entry, candidates) {
      const scores = { wrapper: 0.1, helper: 0.5 };
      return new Map(candidates.map(candidate => [
        candidate.node.id,
        { include: true, score: scores[candidate.node.name] ?? 0.9 },
      ]));
    },
  };
  const result = await retrieve(
    new TypeScriptAdapter(root),
    judge,
    'Change behavior',
    { file: 'src/chain.ts', line: 14 },
    { maxDepth: 1, reverse: false },
  );
  assert.equal(result.bodyThreshold, 0.3);
  assert.equal(result.omitThreshold, 0.3);
  assert.equal(result.items.find(item => item.node.name === 'helper')?.level, 'body');
  assert.equal(result.omitted.find(item => item.node.name === 'wrapper')?.level, 'omitted');
});

test('keeps medium candidates as signatures and looks through a low-scored thin wrapper', async () => {
  const adapter = new TypeScriptAdapter(root);
  const judge = {
    name: 'fixture',
    async judge(_task, _entry, candidates) {
      const scores = { wrapper: 0.1, helper: 0.5, deep: 0.9 };
      return new Map(candidates.map(candidate => [candidate.node.id, { score: scores[candidate.node.name] ?? 0.9, include: true }]));
    },
  };
  const result = await retrieve(adapter, judge, 'Change deep behavior', { file: 'src/chain.ts', line: 14 }, { maxDepth: 2, reverse: false, bodyThreshold: 0.7, omitThreshold: 0.3 });
  assert.equal(result.items.find(item => item.node.name === 'helper')?.level, 'signature');
  assert.equal(result.omitted.find(item => item.node.name === 'wrapper')?.level, 'omitted');
  assert.deepEqual(result.items.find(item => item.node.name === 'deep')?.path, ['entry', 'wrapper', 'deep']);
  assert.equal(result.items.find(item => item.node.name === 'deep')?.level, 'body');
  const withoutLookahead = await retrieve(adapter, judge, 'Change deep behavior',
    { file: 'src/chain.ts', line: 14 }, { maxDepth: 2, reverse: false, wrapperLookahead: false, bodyThreshold: 0.7, omitThreshold: 0.3 });
  assert.equal(withoutLookahead.items.some(item => item.node.name === 'deep'), false);
});

test('maxDepth is a hard bound for runtime and type expansion', async () => {
  const result = await retrieve(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    'Fix token validation',
    { file: 'src/auth.ts', line: 4 },
    { maxDepth: 1, reverse: false },
  );
  assert.ok([...result.items, ...result.omitted].every(item => item.depth <= 1));
});

test('thin-wrapper lookahead follows runtime work without importing wrapper-only types', async () => {
  const judge = {
    name: 'wrapper-runtime-only',
    async judge(_task, _entry, candidates) {
      const scores = { wrapperTyped: 0.1, deepTyped: 0.9 };
      return new Map(candidates.map(candidate => [
        candidate.node.id,
        { include: true, score: scores[candidate.node.name] ?? 0.9 },
      ]));
    },
  };
  const result = await retrieve(
    new TypeScriptAdapter(root),
    judge,
    'Change deep typed behavior',
    { file: 'src/wrapper-types.ts', line: 15 },
    { maxDepth: 2, reverse: false },
  );
  assert.equal(result.omitted.find(item => item.node.name === 'wrapperTyped')?.level, 'omitted');
  assert.equal(result.items.some(item => item.node.name === 'deepTyped'), true);
  assert.equal(result.items.some(item => item.node.name === 'WrapperOnly'), false);
});

test('depth zero provides the entry-only ablation', async () => {
  const result = await retrieve(new TypeScriptAdapter(root), new IncludeAllJudge(), 'Fix token validation',
    { file: 'src/auth.ts', line: 4 }, { maxDepth: 0 });
  assert.deepEqual(result.items.map(item => item.node.name), ['refreshToken']);
  assert.equal(result.considered, 0);
});

test('reports unresolved dynamic calls with source location', async () => {
  const result = await retrieve(new TypeScriptAdapter(root), new IncludeAllJudge(), 'Trace handler',
    { file: 'src/dynamic.ts', line: 2 }, { reverse: false });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.unresolved[0].expression, 'handler');
  assert.equal(result.unresolved[0].site.line, 2);
});

test('resolves tsconfig path aliases and typed property method calls', () => {
  const adapter = new TypeScriptAdapter(root);
  const alias = adapter.findEntry({ file: 'src/alias.ts', line: 4 });
  assert.equal(adapter.dependencies(alias).edges[0].target.name, 'verifyToken');
  const method = adapter.findEntry({ file: 'src/method.ts', line: 7 });
  // Class members are named `Class.member`, the same form discovery and the benchmark labels use.
  const edge = adapter.dependencies(method).edges.find(candidate => candidate.target.name === 'UserRepo.find');
  assert.equal(edge?.kind, 'method');
  assert.equal(edge?.target.file, 'src/method.ts');
});

test('jevtrace setup saves the chosen provider, key and model; the environment still overrides it', async t => {
  const { runSetup } = await import('../dist/setup.js');
  const { Readable, Writable } = await import('node:stream');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  const env = { JEVTRACE_CONFIG: configFile };
  let printed = '';
  const output = new Writable({ write(chunk, _encoding, done) { printed += chunk; done(); } });
  const checked = [];
  // Providers are listed alphabetically: 1 OpenCode Zen, 2 OpenRouter, 3 TypeSafe, 4 Vercel AI Gateway, 5 custom.
  const answers = lines => Readable.from([lines.join('\n') + '\n']);
  const saved = await runSetup({ env, output, input: answers(['3', 'first-key', '', 'n', '']),
    verify: async config => { checked.push(config.apiKey); return checked.length === 1 ? 'HTTP 401: invalid key' : undefined; } });
  assert.deepEqual(checked, ['first-key']);
  assert.deepEqual(saved, { provider: 'typesafe', apiKey: 'first-key' });
  assert.match(printed, /1\. OpenCode Zen[\s\S]*2\. OpenRouter[\s\S]*3\. TypeSafe[\s\S]*5\. Custom endpoint/);
  assert.match(printed, /failed\n {2}HTTP 401: invalid key/);
  assert.ok(!printed.includes('first-key'), 'the key is never printed');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { provider: 'typesafe', apiKey: 'first-key' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  // Enter keeps the saved provider and key; a new model is stored.
  await runSetup({ env, output, input: answers(['', '', 'jev-next']), verify: async () => undefined });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { provider: 'typesafe', apiKey: 'first-key', model: 'jev-next' });

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), model: JSON.parse(options.body).model, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ answers: { specific: { noul: 0.9 } } }), { status: 200 });
  };
  try {
    await createJudge(env).judgeTaskScope('Fix the login redirect');
    await createJudge({ ...env, TYPESAFE_API_KEY: 'env-key' }).judgeTaskScope('Fix the logout redirect');
    // The saved key belongs to TypeSafe only; another provider needs its own.
    assert.throws(() => createJudge({ ...env, JEVTRACE_PROVIDER: 'vercel' }), /No API key for Vercel AI Gateway: run `npx -y jevtrace setup` or set AI_GATEWAY_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, [
    { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-next', authorization: 'Bearer first-key' },
    { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-next', authorization: 'Bearer env-key' },
  ]);
});

test('in a terminal the API key is read in raw mode: one * per character, backspace works, the key is never echoed', async t => {
  const { runSetup } = await import('../dist/setup.js');
  const { PassThrough, Writable } = await import('node:stream');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtrace-setup-tty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = mode => { rawModes.push(mode); return input; };
  let printed = '';
  // Answer each prompt as it appears, the way a person types.
  const replies = [[/Provider \[1-5\]: $/, '2\n'], [/\(hidden\): $/, 'sk-ab\u007fc\r'], [/Model \[typesafe\/jev-1\.13\]: $/, '\n']];
  const output = new Writable({ write(chunk, _encoding, done) {
    printed += chunk;
    const next = replies[0];
    if (next && next[0].test(printed)) { replies.shift(); setImmediate(() => input.write(next[1])); }
    done();
  } });
  const saved = await runSetup({ env: { JEVTRACE_CONFIG: path.join(dir, 'config.json') }, input, output, verify: async () => undefined });
  assert.deepEqual(saved, { provider: 'openrouter', apiKey: 'sk-ac' });
  assert.deepEqual(rawModes, [true, false]);
  assert.match(printed, /\(hidden\): \*\*\*\*\*\u0008 \u0008\*\n/);
  assert.ok(!printed.includes('sk-a'));
});
