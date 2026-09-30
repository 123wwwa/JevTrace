import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsage, usageLogPath, type UsageEntry } from './usage-log.js';

/** Search-like built-in tools; a session that used these but never JevTrace searched without it. */
const searchTools = new Set(['Grep', 'Glob', 'Read', 'Search', 'LS']);

export interface SessionUse {
  file: string;
  project: string;
  lastActivity: string;
  jevtraceCalls: number;
  searchCalls: number;
}

/** Scans Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl) for JevTrace and search tool calls. */
export function scanClaudeSessions(sinceMs: number, env: NodeJS.ProcessEnv = process.env): SessionUse[] {
  const projectsDir = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const sessions: SessionUse[] = [];
  for (const projectDir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(projectsDir, projectDir.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(projectsDir, projectDir.name, entry.name);
      const stat = fs.statSync(file);
      if (stat.mtimeMs < sinceMs) continue;
      let project = projectDir.name;
      let jevtraceCalls = 0;
      let searchCalls = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"tool_use"') && !line.includes('"cwd"')) continue;
        let record: { cwd?: string; message?: { content?: unknown } };
        try { record = JSON.parse(line); } catch { continue; }
        if (typeof record.cwd === 'string') project = record.cwd;
        const content = record.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<{ type?: string; name?: string }>) {
          if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
          if (block.name.startsWith('mcp__jevtrace__')) jevtraceCalls++;
          else if (searchTools.has(block.name)) searchCalls++;
        }
      }
      if (jevtraceCalls || searchCalls) sessions.push({ file, project, lastActivity: stat.mtime.toISOString(), jevtraceCalls, searchCalls });
    }
  }
  return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

const sum = (values: Array<number | undefined>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const n = (value: number) => Math.round(value).toLocaleString('en-US');

export function formatStats(days: number, env: NodeJS.ProcessEnv = process.env): string {
  const sinceMs = Date.now() - days * 86_400_000;
  const calls = readUsage(env).filter(entry => Date.parse(entry.time) >= sinceMs);
  const lines: string[] = [`JevTrace usage, last ${days} day${days === 1 ? '' : 's'}`, ''];

  const logFile = usageLogPath(env);
  if (!logFile) lines.push('Tool-call log: disabled (JEVTRACE_USAGE_LOG=off).');
  else if (!calls.length) lines.push(`Tool calls: none recorded (${logFile}).`);
  else {
    const retrievals = calls.filter(entry => entry.tool === 'retrieve_dependency_context');
    const byTool = new Map<string, UsageEntry[]>();
    for (const entry of calls) byTool.set(entry.tool, [...(byTool.get(entry.tool) ?? []), entry]);
    lines.push(`Tool calls: ${calls.length} (${[...byTool].map(([tool, entries]) => `${tool} ${entries.length}`).join(', ')})`);
    lines.push(`  failed: ${calls.filter(entry => !entry.ok).length}, no relevant code found: ${retrievals.filter(entry => entry.outcome === 'no-context').length}`);
    const withSavings = retrievals.filter(entry => entry.candidateTokens !== undefined);
    const candidate = sum(withSavings.map(entry => entry.candidateTokens));
    const saved = sum(withSavings.map(entry => entry.savedTokens));
    lines.push(`  tokens: ${n(sum(withSavings.map(entry => entry.returnedTokens)))} sent to the agent, ${n(saved)} excluded from ${n(candidate)} candidates${candidate ? ` (${(saved / candidate * 100).toFixed(1)}%)` : ''}`);
    lines.push(`  Jev: ${n(sum(calls.map(entry => entry.jevRequests)))} requests, ${n(sum(calls.map(entry => entry.jevInputTokens)))} input tokens, $${sum(calls.map(entry => entry.jevCost)).toFixed(4)}`);
    lines.push(`  time: ${(sum(retrievals.map(entry => entry.ms)) / Math.max(retrievals.length, 1) / 1000).toFixed(1)} s per retrieval`);
    const byProject = new Map<string, number>();
    for (const entry of calls) byProject.set(entry.project, (byProject.get(entry.project) ?? 0) + 1);
    lines.push('', 'By project:', ...[...byProject].sort((a, b) => b[1] - a[1]).map(([project, count]) => `  ${count}  ${project}`));
    lines.push('', 'Recent calls:', ...calls.slice(-8).reverse().map(entry =>
      `  ${entry.time.slice(0, 16).replace('T', ' ')}  ${entry.tool.padEnd(27)} ${entry.outcome.padEnd(10)} ${String(Math.round(entry.ms / 100) / 10).padStart(5)}s  ${entry.task.slice(0, 70)}`));
  }

  const sessions = scanClaudeSessions(sinceMs, env);
  lines.push('', `Claude Code sessions with code search: ${sessions.length}`);
  if (sessions.length) {
    const used = sessions.filter(session => session.jevtraceCalls > 0);
    const without = sessions.filter(session => session.jevtraceCalls === 0);
    lines.push(`  used JevTrace: ${used.length}`, `  searched with Grep/Glob/Read only: ${without.length}`);
    lines.push('', 'Recent sessions:', ...sessions.slice(0, 8).map(session =>
      `  ${session.lastActivity.slice(0, 16).replace('T', ' ')}  jevtrace ${String(session.jevtraceCalls).padStart(2)}  search ${String(session.searchCalls).padStart(3)}  ${session.project}`));
  }
  return lines.join('\n');
}
