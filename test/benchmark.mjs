import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeScriptAdapter } from '../dist/typescript-adapter.js';
import { IncludeAllJudge, OpenRouterJevJudge } from '../dist/judges.js';
import { evaluateCase } from '../dist/evaluate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');

const benchmarkCase = {
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

const oracleRelevant = new Set([
  'verifyToken',
  'TokenPayload',
  'decodeJWT',
  'findUser',
  'createAccessToken',
]);

const oracleJudge = {
  name: 'oracle-filter',
  async judge(_task, _entry, candidates) {
    return new Map(candidates.map(candidate => {
      const relevant = oracleRelevant.has(candidate.node.name);
      return [candidate.node.id, { include: relevant, score: relevant ? 0.9 : 0.1 }];
    }));
  },
};

const fixed = {
  reverse: false,
  tokenBudget: 8000,
  maxNodes: 30,
  wrapperLookahead: true,
};

const runs = [];

runs.push(await evaluateCase(
  new TypeScriptAdapter(root),
  new IncludeAllJudge(),
  benchmarkCase,
  { ...fixed, maxDepth: 0 },
  'entry-only',
));

runs.push(await evaluateCase(
  new TypeScriptAdapter(root),
  new IncludeAllJudge(),
  benchmarkCase,
  { ...fixed, maxDepth: 2 },
  'static-all',
));

runs.push(await evaluateCase(
  new TypeScriptAdapter(root),
  oracleJudge,
  benchmarkCase,
  { ...fixed, maxDepth: 2, visitPolicy: 'score' },
  'oracle-filter',
));

if (process.env.OPENROUTER_API_KEY) {
  runs.push(await evaluateCase(
    new TypeScriptAdapter(root),
    new OpenRouterJevJudge(process.env.OPENROUTER_API_KEY),
    benchmarkCase,
    { ...fixed, maxDepth: 2, visitPolicy: 'score' },
    'jev-score',
  ));
} else {
  process.stderr.write('OPENROUTER_API_KEY is not set; skipping real Jev run.\n');
}

const percent = value => (value * 100).toFixed(1) + '%';
const number = value => Number(value.toFixed(2));

console.table(runs.map(({ method, metrics }) => ({
  method,
  recall: percent(metrics.recall),
  precision: percent(metrics.precision),
  bodyRecall: percent(metrics.bodyRecall),
  requiredRecall: percent(metrics.requiredLevelRecall),
  tokens: metrics.usedTokens,
  relevantPer1k: number(metrics.relevantPer1kTokens),
  omittedRelevant: metrics.omittedRelevant,
  considered: metrics.considered,
  unresolved: metrics.unresolved,
  latencyMs: number(metrics.latencyMs),
})));

for (const run of runs) {
  console.log('\n[' + run.method + ']');
  console.log('included:', run.result.items.map(item => item.node.name + ':' + item.level).join(', '));
  if (run.result.omitted.length) {
    console.log('omitted:', run.result.omitted.map(item => item.node.name).join(', '));
  }
}
