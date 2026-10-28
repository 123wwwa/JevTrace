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
import { clientsGuide, configuredProvider, runSetup } from './setup.js';
import { explainError, UserFacingError } from './errors.js';
import { unsuitableRoot } from './fs-walk.js';
import { version } from './version.js';
import { superviseStdio } from './supervisor.js';
import { userConfigStamp } from './user-config.js';

const help = [
  `jevtrace ${version}: an MCP server that hands coding agents the JS/TS code a task needs.`,
  '',
  'Usage:',
  '  jevtrace setup                              choose a Jev provider and enter its API key (once)',
  '  jevtrace [--root DIR]                       run the MCP server over stdio; this is what your agent starts',
  '  jevtrace query --task TEXT [--root DIR]     print the context for a task as JSON (--offline needs no provider)',
  '  jevtrace discover --task TEXT [--root DIR]  print the discovery candidates as JSON',
  '  jevtrace stats [--days N]                   summarize the local usage log',
  '  jevtrace --help | --version',
  '',
  'Register it with your agent:',
  '  Claude Code:     claude mcp add jevtrace --scope user -- npx -y jevtrace',
  `  Codex, Cursor:   ${clientsGuide}`,
  'More options and examples: https://github.com/123wwwa/JevTrace/blob/main/docs/usage.md',
  '',
].join('\n');

/** Ends the process with a message a person can act on; `explainError` words anything unexpected. */
const fail = (error: unknown): never => {
  process.stderr.write(`jevtrace: ${explainError(error)}\n`);
  process.exit(1);
};
// Anything that escapes a handler still ends with an explanation, not a bare stack or a silent exit.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const args = process.argv.slice(2);
const command = args[0];
if (args.some(arg => arg === '--help' || arg === '-h') || command === 'help') {
  process.stdout.write(help);
  process.exit(0);
}
if (command === '--version' || command === '-v' || command === 'version') {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
// A mistyped command used to fall through to the MCP server, which then waited on stdin without a word.
const commands = ['setup', 'stats', 'query', 'discover'];
if (command !== undefined && !command.startsWith('-') && !commands.includes(command)) {
  process.stderr.write(`jevtrace: unknown command "${command}".\n\n${help}`);
  process.exit(1);
}

const argument = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
/** Rejects options this command does not have, so a typo is reported instead of silently ignored. */
function checkOptions(valued: string[], switches: string[] = []): void {
  for (let index = command?.startsWith('-') ? 0 : 1; index < args.length; index++) {
    const option = args[index];
    if (switches.includes(option)) continue;
    if (!valued.includes(option)) throw new UserFacingError(`Unknown option ${option}${command && !command.startsWith('-') ? ` for \`jevtrace ${command}\`` : ''}. Run \`jevtrace --help\` for usage.`);
    if (args[++index] === undefined) throw new UserFacingError(`${option} needs a value.`);
  }
}
function numberArgument(name: string): number | undefined;
function numberArgument(name: string, fallback: number): number;
function numberArgument(name: string, fallback?: number): number | undefined {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  if (!raw.trim() || !Number.isFinite(Number(raw))) throw new UserFacingError(`${name} needs a number, got "${raw}".`);
  return Number(raw);
}
function choiceArgument<const Choice extends string>(name: string, choices: readonly Choice[], fallback: Choice): Choice {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  if (!choices.includes(raw as Choice)) throw new UserFacingError(`${name} must be one of ${choices.join(', ')}, got "${raw}".`);
  return raw as Choice;
}

if (command === 'setup') {
  try {
    checkOptions([]);
    await runSetup();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`\n${explainError(error)}\n`);
    process.exit(1);
  }
}

// Someone ran the server by hand in a terminal (MCP hosts connect through pipes): set it up or explain.
if (command === undefined && process.stdin.isTTY) {
  if (!configuredProvider()) {
    process.stdout.write('No decision provider is configured yet; starting setup.\n\n');
    try { await runSetup(); } catch (error) {
      process.stderr.write(`\n${explainError(error)}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write(help);
  }
  process.exit(0);
}

if (command === 'stats') {
  try {
    checkOptions(['--days']);
    const days = numberArgument('--days', 7);
    if (days <= 0) throw new UserFacingError(`--days needs a number above 0, got "${argument('--days')}".`);
    process.stdout.write(formatStats(days) + '\n');
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

const queryValues = ['--root', '--task', '--file', '--line', '--symbol', '--evidence', '--provider', '--model', '--endpoint',
  '--max-candidates', '--max-leads', '--max-files', '--max-jev-files', '--max-relevant-directories', '--max-relevant-files',
  '--max-depth', '--max-nodes', '--token-budget', '--body-threshold', '--omit-threshold', '--reverse-fan-in',
  '--per-lead-node-limit', '--per-lead-token-budget', '--neighborhood-token-budget', '--lexical-merge-limit',
  '--context-ranking', '--visit-policy'];
const querySwitches = ['--offline', '--no-reverse', '--no-scope-check', '--no-wrapper-lookahead', '--lexical-final-merge', '--include-lexical-parallel'];
const retrieving = command === 'query' || command === 'discover';
try {
  if (retrieving) checkOptions(queryValues, querySwitches);
  else checkOptions(['--root']);
} catch (error) {
  fail(error);
}

// Without --root, follow the host's project: Claude Code passes it as CLAUDE_PROJECT_DIR and starts
// user-scope servers from its own configuration directory, so the working directory is not the project.
const root = path.resolve(argument('--root') ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd()));
// Fail at startup with the reason on stderr (which MCP hosts show in their logs), not at the first request.
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  process.stderr.write(`jevtrace: the project folder ${root} does not exist or is not a folder. Check the --root you registered, or start your agent from the project folder.\n`);
  process.exit(1);
}
const unsuitable = unsuitableRoot(root);
if (retrieving) {
  if (unsuitable) {
    process.stderr.write(`${unsuitable.replace(/your agent/, 'this command').replace(/start the agent/, 'run it')}\n`);
    process.exit(1);
  }
  try {
    const evidencePath = argument('--evidence');
    let evidence: { path?: string; leads?: Array<{ name: string; range: { startLine: number; endLine: number }; score: number }> } | undefined;
    if (evidencePath) {
      try {
        evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      } catch (error) {
        throw new UserFacingError(`Cannot read the evidence file ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const lead = [...(evidence?.leads ?? [])].sort((a, b) => b.score - a.score)[0];
    const file = argument('--file') ?? evidence?.path;
    const task = argument('--task');
    const line = numberArgument('--line') ?? lead?.range.startLine;
    if (!task?.trim()) throw new UserFacingError(`\`jevtrace ${command}\` needs --task, for example:\n  jevtrace ${command} --task "Fix refresh token validation" --root /path/to/project`);
    if (evidencePath && !file) throw new UserFacingError(`The evidence file ${evidencePath} has no "path" to start from.`);
    if (file && line === undefined && !argument('--symbol')) throw new UserFacingError('--file needs --line N or --symbol NAME to say which declaration to start from.');
    if (!file && (line !== undefined || argument('--symbol'))) throw new UserFacingError('--line and --symbol need --file PATH.');

    if (!args.includes('--offline') && !argument('--provider') && !configuredProvider() && process.stdin.isTTY) {
      process.stderr.write('No decision provider is configured yet; starting setup (or rerun with --offline).\n\n');
      await runSetup({ output: process.stderr });
    }
    const judge = args.includes('--offline')
      ? new IncludeAllJudge()
      : createJudge(process.env, {
        provider: argument('--provider') as JevProvider | undefined,
        model: argument('--model'),
        endpoint: argument('--endpoint'),
      });
    const index = new RepositoryIndex(root);
    const adapter = new TypeScriptAdapter(root);
    const discoveryOptions = {
      maxCandidates: numberArgument('--max-candidates', 64),
      maxLeads: numberArgument('--max-leads', 4),
      maxFiles: numberArgument('--max-files', defaultMaxFiles),
      maxJevFiles: numberArgument('--max-jev-files', 256),
      maxRelevantDirectories: numberArgument('--max-relevant-directories', 8),
      maxRelevantFiles: numberArgument('--max-relevant-files', 8),
    };
    const result = command === 'discover' ? await discoverEntries(index, judge, task, discoveryOptions, adapter)
      : await query(index, adapter, judge, task,
      file ? { file, line, endLine: lead?.range.endLine, symbol: argument('--symbol') ?? lead?.name, score: lead?.score } : undefined,
      { maxDepth: numberArgument('--max-depth', 4), maxNodes: numberArgument('--max-nodes', 30),
        ...discoveryOptions,
        tokenBudget: numberArgument('--token-budget', 8000), bodyThreshold: numberArgument('--body-threshold', 0.3),
        omitThreshold: numberArgument('--omit-threshold', 0.3), reverse: !args.includes('--no-reverse'),
        reverseFanIn: numberArgument('--reverse-fan-in', 12),
        perLeadNodeLimit: numberArgument('--per-lead-node-limit', 24),
        perLeadTokenBudget: numberArgument('--per-lead-token-budget'),
        neighborhoodTokenBudget: numberArgument('--neighborhood-token-budget'),
        lexicalMergeLimit: numberArgument('--lexical-merge-limit', 64),
        includeLexicalParallel: args.includes('--lexical-final-merge') || args.includes('--include-lexical-parallel'),
        contextRanking: choiceArgument('--context-ranking', ['jev', 'structural'], 'jev'),
        scopeCheck: !args.includes('--no-scope-check'),
        wrapperLookahead: !args.includes('--no-wrapper-lookahead'), visitPolicy: choiceArgument('--visit-policy', ['score', 'choice'], 'score') });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${explainError(error)}\n`);
    process.exitCode = 1;
  }
} else if (process.env.JEVTRACE_WORKER === '1') {
  // The server itself, started by the supervisor below (or directly, with JEVTRACE_WORKER=1, to debug it).
  serveStdio(() => createServer(root));
} else {
  // MCP hosts show stderr in their logs; tool calls report the same with the fix.
  if (!configuredProvider()) process.stderr.write('jevtrace: no decision provider is configured; run `npx -y jevtrace setup` in a terminal\n');
  // The server still starts, so the agent can show this message as the tool's answer; the log gets it too.
  if (unsuitable) process.stderr.write(`jevtrace: ${unsuitable}\n`);
  // The server runs as a child of this process, which keeps the host's connection: when `jevtrace setup` saves
  // a new key or provider, the next call restarts the server with it, and the agent keeps its session.
  const code = await superviseStdio({
    command: process.execPath,
    args: [...process.execArgv, process.argv[1], ...args],
    env: { ...process.env, JEVTRACE_WORKER: '1' },
    stamp: () => userConfigStamp(),
    log: message => process.stderr.write(`jevtrace: ${message}\n`),
  });
  process.exit(code);
}
