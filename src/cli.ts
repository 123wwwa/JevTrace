#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { TypeScriptAdapter } from './typescript-adapter.js';
import { createJudge, IncludeAllJudge } from './judges.js';
import type { JevProvider } from './judges.js';
import { query } from './query.js';
import { RepositoryIndex, discoverEntries } from './discovery.js';

const rootArgument = process.argv.indexOf('--root');
if (rootArgument >= 0 && !process.argv[rootArgument + 1]) {
  process.stderr.write('Usage: jevtrace [--root /path/to/project]\n');
  process.exit(1);
}
const root = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : process.cwd();
if (process.argv[2] === 'query' || process.argv[2] === 'discover') {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const evidencePath = argument('--evidence');
  const evidence = evidencePath ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
    path: string; leads: Array<{ name: string; range: { startLine: number; endLine: number }; score: number }>
  } : undefined;
  const lead = [...(evidence?.leads ?? [])].sort((a, b) => b.score - a.score)[0];
  const file = argument('--file') ?? evidence?.path;
  const task = argument('--task');
  const line = argument('--line') ? Number(argument('--line')) : lead?.range.startLine;
  if (!task || (file && line === undefined && !argument('--symbol') && !lead) || (!file && (line !== undefined || argument('--symbol') || evidencePath))) {
    process.stderr.write('Usage: jevtrace query|discover --task TEXT [--file PATH --line N | --file PATH --symbol NAME | --evidence FILE.json] [--root DIR] [--max-candidates 64] [--max-leads 4] [--max-jev-files 256] [--max-relevant-files 8] [--provider openrouter|typesafe|vercel|opencode|custom] [--model MODEL] [--endpoint URL] [--offline]\n');
    process.exit(1);
  }
  try {
    const judge = process.argv.includes('--offline')
      ? new IncludeAllJudge()
      : createJudge(process.env, {
        provider: argument('--provider') as JevProvider | undefined,
        model: argument('--model'),
        endpoint: argument('--endpoint'),
      });
    const index = new RepositoryIndex(root);
    const adapter = new TypeScriptAdapter(root);
    const discoveryOptions = {
      maxCandidates: Number(argument('--max-candidates') ?? 64),
      maxLeads: Number(argument('--max-leads') ?? 4),
      maxFiles: Number(argument('--max-files') ?? 3000),
      maxJevFiles: Number(argument('--max-jev-files') ?? 256),
      maxRelevantDirectories: Number(argument('--max-relevant-directories') ?? 8),
      maxRelevantFiles: Number(argument('--max-relevant-files') ?? 8),
    };
    const result = process.argv[2] === 'discover' ? await discoverEntries(index, judge, task, discoveryOptions, adapter)
      : await query(index, adapter, judge, task,
      file ? { file, line, endLine: lead?.range.endLine, symbol: argument('--symbol') ?? lead?.name, score: lead?.score } : undefined,
      { maxDepth: Number(argument('--max-depth') ?? 4), maxNodes: Number(argument('--max-nodes') ?? 30),
        ...discoveryOptions,
        tokenBudget: Number(argument('--token-budget') ?? 8000), bodyThreshold: Number(argument('--body-threshold') ?? 0.3),
        omitThreshold: Number(argument('--omit-threshold') ?? 0.3), reverse: !process.argv.includes('--no-reverse'),
        reverseFanIn: Number(argument('--reverse-fan-in') ?? 12),
        perLeadNodeLimit: Number(argument('--per-lead-node-limit') ?? 24),
        perLeadTokenBudget: argument('--per-lead-token-budget') ? Number(argument('--per-lead-token-budget')) : undefined,
        neighborhoodTokenBudget: argument('--neighborhood-token-budget') ? Number(argument('--neighborhood-token-budget')) : undefined,
        lexicalMergeLimit: Number(argument('--lexical-merge-limit') ?? 64),
        includeLexicalParallel: process.argv.includes('--lexical-final-merge') || process.argv.includes('--include-lexical-parallel'),
        contextRanking: argument('--context-ranking') === 'structural' ? 'structural' : 'jev',
        wrapperLookahead: !process.argv.includes('--no-wrapper-lookahead'), visitPolicy: argument('--visit-policy') === 'choice' ? 'choice' : 'score' });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
} else {
  serveStdio(() => createServer(root));
}
