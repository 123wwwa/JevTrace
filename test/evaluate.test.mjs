import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge } from '../dist/judges.js';
import { aggregateRuns, evaluateCase, scoreContextFootprint, scoreLeadRecovery, scoreRetrieval } from '../dist/evaluate.js';
import { retrieve } from '../dist/retrieve.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');

const authCase = {
  id: 'refresh-token',
  task: 'Fix token validation',
  entry: { file: 'src/auth.ts', line: 4 },
  gold: [
    { file: 'src/jwt.ts', name: 'verifyToken', line: 7, requiredLevel: 'body' },
    { file: 'src/jwt.ts', name: 'TokenPayload', line: 1, requiredLevel: 'signature' },
    { file: 'src/jwt.ts', name: 'decodeJWT', line: 3, requiredLevel: 'body' },
  ],
};

test('scores known dependencies at fixed depth without counting the entry', async () => {
  const result = await retrieve(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    authCase.task,
    authCase.entry,
    { maxDepth: 2, reverse: false, tokenBudget: 8000 },
  );

  const metrics = scoreRetrieval(result, authCase.gold);

  assert.equal(metrics.goldCount, 3);
  assert.equal(metrics.retrievedCount, 3);
  assert.equal(metrics.relevantRetrieved, 3);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.bodyRecall, 1);
  assert.equal(metrics.requiredLevelRecall, 1);
  assert.equal(metrics.omittedRelevant, 0);
  assert.ok(metrics.usedTokens > 0);
  assert.ok(metrics.relevantPer1kTokens > 0);
});

test('reports compactness and actual lead-to-canonical depth without calling it precision', async () => {
  const result = await retrieve(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    authCase.task,
    authCase.entry,
    { maxDepth: 2, reverse: false, tokenBudget: 8000 },
  );
  const targets = [
    { file: 'src/auth.ts', name: 'refreshToken', line: 4, requiredLevel: 'body' },
    ...authCase.gold,
  ];
  const footprint = scoreContextFootprint(result, targets);
  const recovery = scoreLeadRecovery(result, [{ file: 'src/auth.ts', line: 4 }]);
  assert.equal(footprint.includedSymbols, 4);
  assert.ok(footprint.includedFiles >= 2);
  assert.equal(footprint.requiredIncluded, 4);
  assert.equal(footprint.minimumRequiredDensity, 1);
  assert.equal(recovery.canonicalEntryDepth, 0);
  assert.equal(recovery.canonicalWithin1, true);
});

test('entry-only ablation has zero dependency recall', async () => {
  const run = await evaluateCase(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    authCase,
    { maxDepth: 0, reverse: false, tokenBudget: 8000 },
    'entry-only',
  );

  assert.equal(run.method, 'entry-only');
  assert.equal(run.metrics.retrievedCount, 0);
  assert.equal(run.metrics.recall, 0);
  assert.equal(run.metrics.requiredLevelRecall, 0);
  assert.ok(run.metrics.latencyMs >= 0);
});

test('required-level recall distinguishes signatures from bodies', async () => {
  const judge = {
    name: 'fixture-scores',
    async judge(_task, _entry, candidates) {
      const scores = { wrapper: 0.1, helper: 0.5, deep: 0.9 };
      return new Map(candidates.map(candidate => [
        candidate.node.id,
        { include: (scores[candidate.node.name] ?? 0.9) >= 0.5, score: scores[candidate.node.name] ?? 0.9 },
      ]));
    },
  };

  const benchmarkCase = {
    id: 'thin-wrapper',
    task: 'Change deep behavior',
    entry: { file: 'src/chain.ts', line: 14 },
    gold: [
      { file: 'src/chain.ts', name: 'helper', line: 9, requiredLevel: 'body' },
      { file: 'src/chain.ts', name: 'deep', line: 1, requiredLevel: 'body' },
    ],
  };

  const run = await evaluateCase(
    new TypeScriptAdapter(root),
    judge,
    benchmarkCase,
    { maxDepth: 2, reverse: false, wrapperLookahead: true, bodyThreshold: 0.7, omitThreshold: 0.3 },
  );

  assert.equal(run.metrics.recall, 1);
  assert.equal(run.metrics.bodyRecall, 0.5);
  assert.equal(run.metrics.requiredLevelRecall, 0.5);
  assert.equal(run.result.items.find(item => item.node.name === 'helper')?.level, 'signature');
  assert.equal(run.result.items.find(item => item.node.name === 'deep')?.level, 'body');
});

test('counts a relevant candidate that Jev omitted', async () => {
  const judge = {
    name: 'omit-decode',
    async judge(_task, _entry, candidates) {
      return new Map(candidates.map(candidate => [
        candidate.node.id,
        { include: candidate.node.name !== 'decodeJWT', score: candidate.node.name === 'decodeJWT' ? 0.1 : 0.9 },
      ]));
    },
  };

  const result = await retrieve(
    new TypeScriptAdapter(root),
    judge,
    authCase.task,
    authCase.entry,
    { maxDepth: 2, reverse: false, wrapperLookahead: false },
  );
  const metrics = scoreRetrieval(result, authCase.gold);

  assert.equal(metrics.omittedRelevant, 1);
  assert.equal(metrics.recall, 2 / 3);
});

test('noisy fixture exposes the precision gain available to relevance filtering', async () => {
  const noisyCase = {
    id: 'noisy-refresh-token',
    task: 'Fix the refresh token flow so a verified user receives a new access token',
    entry: { file: 'src/noisy-auth.ts', line: 7 },
    gold: [
      { file: 'src/jwt.ts', name: 'verifyToken', line: 7, requiredLevel: 'body' },
      { file: 'src/jwt.ts', name: 'TokenPayload', line: 1, requiredLevel: 'signature' },
      { file: 'src/jwt.ts', name: 'decodeJWT', line: 3, requiredLevel: 'body' },
      { file: 'src/users.ts', name: 'findUser', line: 1, requiredLevel: 'body' },
      { file: 'src/access.ts', name: 'createAccessToken', line: 1, requiredLevel: 'body' },
    ],
  };

  const staticRun = await evaluateCase(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    noisyCase,
    { maxDepth: 2, reverse: false },
    'static-all',
  );

  const relevant = new Set(['verifyToken', 'decodeJWT', 'findUser', 'createAccessToken']);
  const oracleJudge = {
    name: 'oracle-filter',
    async judge(_task, _entry, candidates) {
      return new Map(candidates.map(candidate => {
        const include = relevant.has(candidate.node.name);
        return [candidate.node.id, { include, score: include ? 0.9 : 0.1 }];
      }));
    },
  };

  const filteredRun = await evaluateCase(
    new TypeScriptAdapter(root),
    oracleJudge,
    noisyCase,
    { maxDepth: 2, reverse: false },
    'oracle-filter',
  );

  assert.equal(staticRun.metrics.recall, 1);
  assert.equal(staticRun.metrics.retrievedCount, 8);
  assert.equal(staticRun.metrics.relevantRetrieved, 5);
  assert.equal(staticRun.metrics.precision, 5 / 8);

  assert.equal(filteredRun.metrics.recall, 1);
  assert.equal(filteredRun.metrics.retrievedCount, 5);
  assert.equal(filteredRun.metrics.precision, 1);
  assert.ok(filteredRun.metrics.usedTokens < staticRun.metrics.usedTokens);
});

test('aggregates multiple runs for comparison tables', async () => {
  const full = await evaluateCase(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    authCase,
    { maxDepth: 2, reverse: false },
    'static-all',
  );
  const entryOnly = await evaluateCase(
    new TypeScriptAdapter(root),
    new IncludeAllJudge(),
    authCase,
    { maxDepth: 0, reverse: false },
    'entry-only',
  );

  const aggregate = aggregateRuns([full, entryOnly]);

  assert.equal(aggregate.cases, 2);
  assert.equal(aggregate.meanRecall, 0.5);
  assert.equal(aggregate.meanRequiredLevelRecall, 0.5);
  assert.ok(aggregate.meanUsedTokens > 0);
  assert.ok(aggregate.meanLatencyMs >= 0);
});
