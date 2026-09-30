import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JudgeCallStats } from './types.js';

/**
 * One line per MCP tool call, kept locally so usage can be reviewed across server restarts
 * (`jevtrace stats`). Set JEVTRACE_USAGE_LOG to a file path to move it, or to `off` to disable it.
 * It records the task text and project path; nothing is sent anywhere.
 */
export interface UsageEntry {
  time: string;
  tool: 'retrieve_dependency_context' | 'retrieve_from_entry' | 'discover_entries';
  project: string;
  task: string;
  ok: boolean;
  ms: number;
  /** 'complete' | 'incomplete' | 'broad' | 'not-covered' | 'no-context' | 'error' */
  outcome: string;
  candidateTokens?: number;
  returnedTokens?: number;
  savedTokens?: number;
  jevRequests?: number;
  jevInputTokens?: number;
  jevCost?: number;
  error?: string;
}

export function usageLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.JEVTRACE_USAGE_LOG;
  if (configured && configured.toLowerCase() === 'off') return undefined;
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.jevtrace', 'usage.jsonl');
}

/** Totals over the provider batches of one or more judge calls. */
export function jevUsage(...stats: Array<JudgeCallStats | undefined>): Pick<UsageEntry, 'jevRequests' | 'jevInputTokens' | 'jevCost'> {
  const batches = stats.flatMap(stat => stat?.batches ?? []);
  return {
    jevRequests: batches.reduce((sum, batch) => sum + batch.attempts, 0),
    jevInputTokens: batches.reduce((sum, batch) => sum + (batch.inputTokens ?? 0), 0),
    jevCost: batches.reduce((sum, batch) => sum + (batch.cost ?? 0), 0),
  };
}

/** Best effort: a logging failure must never fail the tool call. */
export function appendUsage(entry: UsageEntry, env: NodeJS.ProcessEnv = process.env): void {
  const file = usageLogPath(env);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore: read-only home directories and similar must not break retrieval.
  }
}

export function readUsage(env: NodeJS.ProcessEnv = process.env): UsageEntry[] {
  const file = usageLogPath(env);
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as UsageEntry]; } catch { return []; }
  });
}
