#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { TypeScriptAdapter } from './typescript-adapter.js';
import { createJudge, IncludeAllJudge } from './judges.js';
import type { JevProvider } from './judges.js';
import { query } from './query.js';
import { RepositoryIndex, defaultMaxFiles, discoverEntries } from './discovery.js';
import { formatStats } from './stats.js';
import { configuredProvider, runSetup } from './setup.js';

if (process.argv[2] === 'setup') {
  try {
    await runSetup();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// Someone ran the server by hand in a terminal (MCP hosts connect through pipes): set it up or explain.
if (process.argv.length === 2 && process.stdin.isTTY) {
  if (!configuredProvider()) {
    process.stdout.write('No decision provider is configured yet; starting setup.\n\n');
    try { await runSetup(); } catch (error) {
      process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write([
      'jevtrace is an MCP server over stdio; register it with your agent instead of running it here, e.g.',
      `  claude mcp add jevtrace --scope user -- node "${path.resolve(process.argv[1])}"`,
      'Commands: setup | query --task TEXT [--root DIR] | discover --task TEXT | stats [--days N]',
      '',
    ].join('\n'));
  }
  process.exit(0);
}

if (process.argv[2] === 'stats') {
  const daysArgument = process.argv.indexOf('--days');
  const days = daysArgument >= 0 ? Number(process.argv[daysArgument + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write('Usage: jevtrace stats [--days N]\n');
    process.exit(1);
  }
  process.stdout.write(formatStats(days) + '\n');
  process.exit(0);
}

const rootArgument = process.argv.indexOf('--root');
if (rootArgument >= 0 && !process.argv[rootArgument + 1]) {
  process.stderr.write('Usage: jevtrace [--root /path/to/project]\n');
  process.exit(1);
}
// Without --root, follow the host's project: Claude Code passes it as CLAUDE_PROJECT_DIR and starts
// user-scope servers from its own configuration directory, so the working directory is not the project.
const root = path.resolve(rootArgument >= 0 ? process.argv[rootArgument + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd());
// Fail at startup with the reason on stderr (which MCP hosts show in their logs), not at the first request.
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  process.stderr.write(`jevtrace: project root is not a directory: ${root}\n`);
  process.exit(1);
}
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
    if (!process.argv.includes('--offline') && !argument('--provider') && !configuredProvider() && process.stdin.isTTY) {
      process.stderr.write('No decision provider is configured yet; starting setup (or rerun with --offline).\n\n');
      await runSetup({ output: process.stderr });
    }
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
      maxFiles: Number(argument('--max-files') ?? defaultMaxFiles),
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
        scopeCheck: !process.argv.includes('--no-scope-check'),
        wrapperLookahead: !process.argv.includes('--no-wrapper-lookahead'), visitPolicy: argument('--visit-policy') === 'choice' ? 'choice' : 'score' });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
} else {
  // MCP hosts show stderr in their logs; tool calls report the same with the fix.
  if (!configuredProvider()) process.stderr.write('jevtrace: no decision provider is configured; run `node dist/cli.js setup` in a terminal\n');
  serveStdio(() => createServer(root));
}
