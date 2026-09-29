import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge } from '../dist/judges.js';
import { evaluateCase } from '../dist/evaluate.js';
import { benchmarkCases } from './benchmark-cases.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const key = value => `${value.file}::${value.name}`;

for (const benchmarkCase of benchmarkCases) {
  test(`benchmark case ${benchmarkCase.id} has reachable gold context`, async () => {
    const staticRun = await evaluateCase(
      new TypeScriptAdapter(root),
      new IncludeAllJudge(),
      benchmarkCase,
      { maxDepth: 2, maxNodes: 30, tokenBudget: 2000, reverse: false, wrapperLookahead: true },
      'static-all',
    );

    assert.equal(
      staticRun.metrics.recall,
      1,
      `${benchmarkCase.id}: static graph cannot reach every gold dependency`,
    );

    const relevant = new Set(benchmarkCase.gold.map(key));
    const oracle = {
      name: 'oracle-filter',
      async judge(_task, _entry, candidates) {
        return new Map(candidates.map(candidate => {
          const include = relevant.has(key(candidate.node));
          return [candidate.node.id, { include, score: include ? 0.9 : 0.1 }];
        }));
      },
    };

    const oracleRun = await evaluateCase(
      new TypeScriptAdapter(root),
      oracle,
      benchmarkCase,
      { maxDepth: 2, maxNodes: 30, tokenBudget: 2000, reverse: false, wrapperLookahead: true },
      'oracle-filter',
    );

    assert.equal(
      oracleRun.metrics.recall,
      1,
      `${benchmarkCase.id}: oracle filtering accidentally loses gold context`,
    );
  });
}
