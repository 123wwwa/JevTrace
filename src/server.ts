import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';
import { TypeScriptAdapter } from './typescript-adapter.js';
import { createJudge } from './judges.js';
import { formatContext } from './retrieve.js';
import { query } from './query.js';
import { RepositoryIndex, defaultMaxFiles, discoverEntries, type DiscoveryResult } from './discovery.js';
import type { TaskPipelineResult } from './task-pipeline.js';
import { formatContextSavings, RetrievalLatencyWindow, SessionSavings, summarizeContextSavings, type SessionSavingsStats } from './context-metrics.js';
import { appendUsage, jevUsage } from './usage-log.js';
import type { JudgeCallStats } from './types.js';

const CONTEXT_UI_URI = 'ui://jevtrace/context-savings-v2.html';
const LEGACY_CONTEXT_UI_URI = 'ui://jevtrace/context-savings.html';

// Structured results carry metadata only. Hosts such as Claude Code pass structuredContent to the model
// alongside the text, so shipping candidate pools with full source there bypassed maxChars (hundreds of
// thousands of characters). Source code lives in the text content, which maxChars bounds.
type Node = { name: string; file: string; startLine: number; endLine: number };
const nodeRef = (node: Node) => ({ name: node.name, file: node.file, startLine: node.startLine, endLine: node.endLine });
const leadRef = (lead: { name: string; file: string; line: number; score?: number }) => ({ name: lead.name, file: lead.file, line: lead.line, score: lead.score });
const compactItems = (items: Array<{ node: Node; level: string; kind?: string; score?: number }>) =>
  items.map(item => ({ node: nodeRef(item.node), level: item.level, kind: item.kind, score: item.score }));
/** The chart needs the curve's shape, not every point; every result also reaches the model. */
function thinSession(session: SessionSavingsStats): SessionSavingsStats {
  const max = 60;
  if (session.points.length <= max) return session;
  const step = session.points.length / max;
  const points = Array.from({ length: max - 1 }, (_, index) => session.points[Math.floor(index * step)]);
  return { ...session, points: [...points, session.points.at(-1)!] };
}

function compactDiscovery(discovery: DiscoveryResult) {
  return {
    task: discovery.task, mode: discovery.mode, status: discovery.status,
    selected: discovery.selected && leadRef(discovery.selected),
    semanticLeads: discovery.semanticLeads.map(leadRef),
    fileLeads: discovery.fileLeads.slice(0, 8).map(file => ({ file: file.file, score: file.score })),
    lexicalCandidates: discovery.lexicalCandidates.slice(0, 8).map(leadRef),
    warnings: discovery.warnings,
  };
}

export function createServer(root = process.cwd()): McpServer {
  const server = new McpServer({ name: 'jevtrace', version: '0.1.0' }, {
    instructions: 'JevTrace finds the code a JavaScript/TypeScript coding task needs when you do not yet know where it lives, especially when the change spans several files. In that case call retrieve_dependency_context with the task before searching with grep: it returns the relevant functions plus the callers, callees, types and tests the TypeScript compiler links to them, within a token budget. Describe one behaviour or area. When you split a larger request (review everything, fix bugs anywhere, a change touching several features) into subtasks, call it once per subtask, including from subagents; a project-wide request returns suggested per-area subtasks and a repository map instead of code.If you already know the file or symbol, read it directly instead. Read further files only for what the result did not cover.',
  });
  const projectRoot = path.resolve(root);
  const adapter = new TypeScriptAdapter(projectRoot);
  const index = new RepositoryIndex(projectRoot);
  const retrievalLatencies = new RetrievalLatencyWindow(50);
  const sessionSavings = new SessionSavings();
  let judge: ReturnType<typeof createJudge> | undefined;
  // The adapter owns one active TS project; do not switch it during another request's await.
  let retrievalTail: Promise<void> = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = retrievalTail;
    let release!: () => void;
    retrievalTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  };

  const registerContextUi = (uri: string) => {
    registerAppResource(server, 'JevTrace context savings', uri, {
      title: 'JevTrace Context Savings',
      description: 'Interactive context-reduction and retrieval telemetry for retrieve_dependency_context.',
      mimeType: RESOURCE_MIME_TYPE,
    }, async resourceUri => {
      const html = await readFile(new URL('./context-savings.html', import.meta.url), 'utf8');
      return { contents: [{ uri: resourceUri.href, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    });
  };
  registerContextUi(CONTEXT_UI_URI);
  registerContextUi(LEGACY_CONTEXT_UI_URI);

  registerAppTool(server, 'retrieve_dependency_context', {
    title: 'Retrieve JevTrace context',
    description: 'Use first when a JS/TS task needs code you have not located yet ("where is X handled", "change how Y works"): give the task in plain words and get the implementing functions plus the callers, callees, types and tests the TypeScript compiler links to them, within a token budget. Cheaper than searching and reading files one by one. Do not pass a file or line; describe the task.',
    _meta: { ui: { resourceUri: CONTEXT_UI_URI } },
    inputSchema: z.object({
      task: z.string().min(1).describe('The coding task, including the intended change or bug'),
      maxCandidates: z.number().int().min(1).max(128).default(64),
      maxLeads: z.number().int().min(1).max(8).default(4),
      maxFiles: z.number().int().min(1).max(100000).default(defaultMaxFiles),
      maxJevFiles: z.number().int().min(1).max(1000).default(256),
      maxRelevantDirectories: z.number().int().min(1).max(32).default(8),
      maxRelevantFiles: z.number().int().min(1).max(32).default(8),
      tokenBudget: z.number().int().min(500).max(100000).default(8000),
      reverseFanIn: z.number().int().min(1).max(100).default(12),
      perLeadNodeLimit: z.number().int().min(1).max(100).default(24),
      perLeadTokenBudget: z.number().int().min(100).max(100000).optional(),
      neighborhoodTokenBudget: z.number().int().min(500).max(200000).optional(),
      lexicalMergeLimit: z.number().int().min(0).max(128).default(64),
      includeLexicalParallel: z.boolean().default(false),
      contextRanking: z.enum(['jev', 'structural']).default('jev'),
      maxChars: z.number().int().min(1000).max(100000).default(30000),
      scopeCheck: z.boolean().default(true).describe('Project-wide tasks ("find bugs", "review the codebase", "scaffold the project") get a repository map instead of code; set false to retrieve for the exact wording anyway'),
    }),
  }, async ({ task, scopeCheck, tokenBudget, reverseFanIn, perLeadNodeLimit, perLeadTokenBudget, neighborhoodTokenBudget, lexicalMergeLimit, includeLexicalParallel, contextRanking, maxChars, maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles }, context) => {
    try {
      const started = performance.now();
      judge ??= createJudge();
      // Select only what the text can show: a token is estimated as four characters, and headings,
      // relationship labels and the omitted/not-followed lists take roughly 5,000 more.
      const effectiveBudget = Math.max(500, Math.min(tokenBudget, Math.floor((maxChars - 5000) / 4)));
      const result = await serialize(() => query(index, adapter, judge!, task, undefined, {
        tokenBudget: effectiveBudget, reverseFanIn,
        maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles,
        perLeadNodeLimit, perLeadTokenBudget, neighborhoodTokenBudget,
        lexicalMergeLimit, includeLexicalParallel, contextRanking,
        scopeCheck, mapChars: Math.max(500, maxChars - 1500),
        signal: context.mcpReq.signal,
      }));
      if (result.status === 'broad') {
        appendUsage({ time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: projectRoot, task, ok: true,
          ms: Math.round(performance.now() - started), outcome: 'broad', ...jevUsage(result.scopeStats) });
        const text = `${result.guidance}

${result.map}`.slice(0, maxChars);
        return { content: [{ type: 'text', text }],
          structuredContent: { context: text, task, status: result.status, specificity: result.specificity, session: thinSession(sessionSavings.snapshot()) } };
      }
      const discoveryText = result.discovery ? `Entry discovery (${result.discovery.mode}): ${result.discovery.selected ? `${result.discovery.selected.file}:${result.discovery.selected.line}` : 'no suitable entry'}\n` : '';
      if ('items' in result) {
        const totalMs = performance.now() - started;
        const latencyStats = retrievalLatencies.record(totalMs);
        const contextSavings = summarizeContextSavings(result, totalMs, latencyStats, sessionSavings);
        const savingsText = `${formatContextSavings(contextSavings)}\n`;
        appendUsage({ time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: projectRoot, task, ok: true, ms: Math.round(totalMs),
          outcome: result.status, candidateTokens: contextSavings.candidateTokens, returnedTokens: contextSavings.returnedTokens, savedTokens: contextSavings.savedTokens,
          ...jevUsage(result.discovery?.judgeStats, 'contextJudgeStats' in result ? result.contextJudgeStats as JudgeCallStats : undefined) });
        const prefix = discoveryText + savingsText;
        const text = prefix + formatContext(result, maxChars - prefix.length);
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            // Claude Code shows the model structuredContent instead of the text content, so the source
            // context has to be here too, first, and within maxChars.
            context: text,
            task, status: result.status, warnings: result.warnings, usedTokens: result.usedTokens, tokenBudget: result.tokenBudget,
            entry: nodeRef(result.entry), items: compactItems(result.items), omittedCount: result.omitted.length,
            rankingPool: 'rankingPool' in result ? { stats: (result as TaskPipelineResult).rankingPool.stats } : undefined,
            contextSavings: { ...contextSavings, session: contextSavings.session && thinSession(contextSavings.session) },
          },
        };
      }
      appendUsage({ time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: projectRoot, task, ok: true,
        ms: Math.round(performance.now() - started), outcome: 'no-context', ...jevUsage(result.discovery?.judgeStats) });
      // No context was found; the dashboard still shows the session totals so far.
      const text = (discoveryText + result.warnings.join('\n')).slice(0, maxChars);
      return { content: [{ type: 'text', text }],
        structuredContent: { context: text, task, status: result.status, warnings: result.warnings, discovery: compactDiscovery(result.discovery), session: thinSession(sessionSavings.snapshot()) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUsage({ time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: projectRoot, task, ok: false, ms: 0, outcome: 'error', error: message.slice(0, 300) });
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  server.registerTool('retrieve_from_entry', {
    title: 'Retrieve from explicit entry (compatibility)',
    description: 'Compatibility path for callers that already have a trusted JS/TS entry location. Use only when the user or an upstream tool explicitly provides the file/line, symbol, or structured evidence; do not infer an entry to call this instead of retrieve_dependency_context.',
    inputSchema: z.object({
      task: z.string().min(1),
      file: z.string().min(1).optional(),
      line: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      symbol: z.string().min(1).optional(),
      evidence: z.object({
        path: z.string(),
        leads: z.array(z.object({ name: z.string(), range: z.object({ startLine: z.number(), endLine: z.number() }), score: z.number() })),
      }).optional(),
      maxDepth: z.number().int().min(0).max(6).default(4),
      maxNodes: z.number().int().min(1).max(100).default(30),
      tokenBudget: z.number().int().min(500).max(100000).default(8000),
      bodyThreshold: z.number().min(0).max(1).default(0.3),
      omitThreshold: z.number().min(0).max(1).default(0.3),
      visitPolicy: z.enum(['score', 'choice']).default('score'),
      wrapperLookahead: z.boolean().default(true),
      reverse: z.boolean().default(true),
      reverseFanIn: z.number().int().min(1).max(100).default(12),
      maxChars: z.number().int().min(1000).max(100000).default(30000),
    }),
  }, async ({ task, file, line, endLine, symbol, evidence, maxDepth, maxNodes, tokenBudget, bodyThreshold, omitThreshold, visitPolicy, wrapperLookahead, reverse, reverseFanIn, maxChars }, context) => {
    try {
      const started = performance.now();
      const lead = [...(evidence?.leads ?? [])].sort((a, b) => b.score - a.score)[0];
      const entryFile = file ?? evidence?.path;
      if (!entryFile || (line === undefined && !lead && !symbol)) throw new Error('Provide an explicit file with line/symbol, or structured evidence with a lead');
      judge ??= createJudge();
      const result = await serialize(() => query(index, adapter, judge!, task,
        { file: entryFile, line: line ?? lead?.range.startLine, endLine: endLine ?? lead?.range.endLine, symbol: symbol ?? lead?.name, score: lead?.score },
        { maxDepth, maxNodes, tokenBudget, bodyThreshold, omitThreshold, visitPolicy, wrapperLookahead, reverse, reverseFanIn, signal: context.mcpReq.signal }));
      appendUsage({ time: new Date().toISOString(), tool: 'retrieve_from_entry', project: projectRoot, task, ok: true, ms: Math.round(performance.now() - started),
        outcome: result.status, returnedTokens: result.usedTokens, jevRequests: result.judgeTrace.reduce((sum, trace) => sum + trace.providerRequests, 0) });
      const text = formatContext(result, maxChars).slice(0, maxChars);
      return { content: [{ type: 'text', text }],
        structuredContent: { context: text, task, status: result.status, warnings: result.warnings, usedTokens: result.usedTokens, tokenBudget: result.tokenBudget,
          entry: nodeRef(result.entry), items: compactItems(result.items), omittedCount: result.omitted.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUsage({ time: new Date().toISOString(), tool: 'retrieve_from_entry', project: projectRoot, task, ok: false, ms: 0, outcome: 'error', error: message.slice(0, 300) });
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
  server.registerTool('discover_entries', {
    description: 'Diagnostics: returns the raw discovery candidates and scores as JSON, not source code. For finding the code a task needs, use retrieve_dependency_context instead.',
    inputSchema: z.object({
      task: z.string().min(1),
      maxCandidates: z.number().int().min(1).max(128).default(64),
      maxLeads: z.number().int().min(1).max(8).default(4),
      maxFiles: z.number().int().min(1).max(100000).default(defaultMaxFiles),
      maxJevFiles: z.number().int().min(1).max(1000).default(256),
      maxRelevantDirectories: z.number().int().min(1).max(32).default(8),
      maxRelevantFiles: z.number().int().min(1).max(32).default(8),
    }),
  }, async ({ task, maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles }, context) => {
    try {
      const started = performance.now();
      judge ??= createJudge();
      const result = await serialize(() => discoverEntries(index, judge!, task,
        { maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles, signal: context.mcpReq.signal }, adapter));
      appendUsage({ time: new Date().toISOString(), tool: 'discover_entries', project: projectRoot, task, ok: true, ms: Math.round(performance.now() - started),
        outcome: result.status, ...jevUsage(result.judgeStats) });
      const summary = compactDiscovery(result);
      const text = [
        `Discovery (${summary.mode}, ${summary.status}) for: ${task}`,
        'Semantic leads:', ...summary.semanticLeads.map(lead => `- ${lead.name} — ${lead.file}:${lead.line}${lead.score === undefined ? '' : ` (${lead.score.toFixed(2)})`}`),
        ...(summary.fileLeads.length ? ['Files:', ...summary.fileLeads.map(file => `- ${file.file} (${file.score.toFixed(2)})`)] : []),
        ...summary.warnings.map(warning => `Warning: ${warning}`),
        'This lists locations only; call retrieve_dependency_context for the code.',
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUsage({ time: new Date().toISOString(), tool: 'discover_entries', project: projectRoot, task, ok: false, ms: 0, outcome: 'error', error: message.slice(0, 300) });
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
  return server;
}
