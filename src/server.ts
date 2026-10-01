import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TypeScriptAdapter } from './typescript-adapter.js';
import { createJudge } from './judges.js';
import { formatContext } from './retrieve.js';
import { query } from './query.js';
import { RepositoryIndex, defaultMaxFiles, describeUnanalysed, discoverEntries, type DiscoveryResult } from './discovery.js';
import type { TaskPipelineResult } from './task-pipeline.js';
import { formatContextSavings, RetrievalLatencyWindow, SessionSavings, summarizeContextSavings } from './context-metrics.js';
import { formatStats } from './stats.js';
import { appendUsage, jevUsage } from './usage-log.js';
import { explainError, UserFacingError } from './errors.js';
import { unsuitableRoot } from './fs-walk.js';
import type { JudgeCallStats } from './types.js';

// Structured results carry metadata only. Hosts such as Claude Code pass structuredContent to the model
// alongside the text, so shipping candidate pools with full source there bypassed maxChars (hundreds of
// thousands of characters). Source code lives in the text content, which maxChars bounds.
type Node = { name: string; file: string; startLine: number; endLine: number };
const nodeRef = (node: Node) => ({ name: node.name, file: node.file, startLine: node.startLine, endLine: node.endLine });
const leadRef = (lead: { name: string; file: string; line: number; score?: number }) => ({ name: lead.name, file: lead.file, line: lead.line, score: lead.score });
const compactItems = (items: Array<{ node: Node; level: string; kind?: string; score?: number }>) =>
  items.map(item => ({ node: nodeRef(item.node), level: item.level, kind: item.kind, score: item.score }));

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
    // A benchmark found agents skipping JevTrace whenever the task named a keyword ("Retry-After"): an earlier
    // "read it directly if you know the symbol" clause gave them the reason. The call is worth making anyway,
    // since a keyword search does not bring the callers, types and tests.
    instructions: 'JevTrace answers "which code does this JavaScript/TypeScript task involve" in one call. For any task or question about how, where or why something works in this repository, or a change to it, call retrieve_dependency_context with the task before using Grep, Glob or Read, also when the task names a keyword, function or file: the result has that code plus the callers, callees, types and tests the TypeScript compiler links to it, which a keyword search does not find. The code it returns is the current source; work from it and read files only for what it does not show. Describe one behaviour or area per call. When you split a larger request (review everything, fix bugs anywhere, a change touching several features) into subtasks, call it once per subtask, including from subagents; a project-wide request returns suggested per-area subtasks and a repository map instead of code.',
  });
  const projectRoot = path.resolve(root);
  // Built on the first tool call rather than here: an error while reading the project (an unreadable folder,
  // a broken config) then reaches the agent as a tool error it can show, instead of failing the MCP handshake
  // with a bare "Internal server error".
  const unsuitable = unsuitableRoot(projectRoot);
  let adapter: TypeScriptAdapter | undefined;
  const project = (): TypeScriptAdapter => {
    if (unsuitable) throw new UserFacingError(unsuitable);
    adapter ??= new TypeScriptAdapter(projectRoot);
    return adapter;
  };
  const index = new RepositoryIndex(projectRoot);
  /** The tool result for a failure, also written to stderr, which MCP hosts keep in their logs. */
  const failure = (tool: string, task: string, error: unknown) => {
    const text = explainError(error);
    process.stderr.write(`jevtrace (${tool}): ${text}\n`);
    appendUsage({ time: new Date().toISOString(), tool: tool as 'retrieve_dependency_context', project: projectRoot, task, ok: false, ms: 0, outcome: 'error', error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    return { isError: true, content: [{ type: 'text' as const, text }] };
  };
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

  server.registerTool('retrieve_dependency_context', {
    title: 'Retrieve JevTrace context',
    description: 'Call first for a JS/TS task or question about this repository ("where is X handled", "change how Y works", "why does Z happen"), even when it names a function, keyword or file: describe the task in plain words and get, in one call, the implementing code plus the callers, callees, types and tests the TypeScript compiler links to it, within a token budget. It usually replaces a series of Grep and Read calls. The code in the result is the current source: work from it and read files only for what it does not show. Do not pass a file or line; describe the task.',
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
      const result = await serialize(() => query(index, project(), judge!, task, undefined, {
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
          structuredContent: { context: text, task, status: result.status, specificity: result.specificity, session: sessionSavings.snapshot() } };
      }
      if (result.status === 'not-covered') {
        appendUsage({ time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: projectRoot, task, ok: true,
          ms: Math.round(performance.now() - started), outcome: 'not-covered', ...jevUsage(result.discovery.judgeStats) });
        const text = [
          'Not covered: this task is about sources JevTrace does not analyse (outside every tsconfig/jsconfig include and not imported by included files), so it returned no code.',
          `Search these directly with Grep/Read instead of calling JevTrace again for this task: ${describeUnanalysed(result.discovery.unanalysedLeads, 12)}`,
          ...result.warnings.map(warning => `Warning: ${warning}`),
        ].join('\n').slice(0, maxChars);
        return { content: [{ type: 'text', text }],
          structuredContent: { context: text, task, status: result.status,
            unanalysed: result.discovery.unanalysedLeads.map(lead => ({ directory: lead.directory, score: lead.score, files: lead.files.slice(0, 50) })),
            session: sessionSavings.snapshot() } };
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
            contextSavings,
          },
        };
      }
      appendUsage({ time: new Date().toISOString(), tool: 'retrieve_dependency_context', project: projectRoot, task, ok: true,
        ms: Math.round(performance.now() - started), outcome: 'no-context', ...jevUsage(result.discovery?.judgeStats) });
      // No context was found; the session totals so far are still reported.
      const text = (discoveryText + result.warnings.join('\n')).slice(0, maxChars);
      return { content: [{ type: 'text', text }],
        structuredContent: { context: text, task, status: result.status, warnings: result.warnings, discovery: compactDiscovery(result.discovery), session: sessionSavings.snapshot() } };
    } catch (error) {
      return failure('retrieve_dependency_context', task, error);
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
      const result = await serialize(() => query(index, project(), judge!, task,
        { file: entryFile, line: line ?? lead?.range.startLine, endLine: endLine ?? lead?.range.endLine, symbol: symbol ?? lead?.name, score: lead?.score },
        { maxDepth, maxNodes, tokenBudget, bodyThreshold, omitThreshold, visitPolicy, wrapperLookahead, reverse, reverseFanIn, signal: context.mcpReq.signal }));
      appendUsage({ time: new Date().toISOString(), tool: 'retrieve_from_entry', project: projectRoot, task, ok: true, ms: Math.round(performance.now() - started),
        outcome: result.status, returnedTokens: result.usedTokens, jevRequests: result.judgeTrace.reduce((sum, trace) => sum + trace.providerRequests, 0) });
      const text = formatContext(result, maxChars).slice(0, maxChars);
      return { content: [{ type: 'text', text }],
        structuredContent: { context: text, task, status: result.status, warnings: result.warnings, usedTokens: result.usedTokens, tokenBudget: result.tokenBudget,
          entry: nodeRef(result.entry), items: compactItems(result.items), omittedCount: result.omitted.length } };
    } catch (error) {
      return failure('retrieve_from_entry', task, error);
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
        { maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles, signal: context.mcpReq.signal }, project()));
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
      return failure('discover_entries', task, error);
    }
  });
  server.registerTool('usage_stats', {
    title: 'JevTrace usage and token savings',
    description: 'Only when the user asks how JevTrace has been used or how many tokens it has saved: returns the local usage log summary (calls, tokens sent and excluded, Jev cost) plus the totals since this server started. Not needed for coding tasks.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(3650).default(30).describe('How many past days of the usage log to summarize'),
    }),
  }, async ({ days }) => {
    const session = sessionSavings.snapshot();
    const current = session.retrievals
      ? `This server session: ${session.savedTokens.toLocaleString('en-US')} tokens excluded from ${session.candidateTokens.toLocaleString('en-US')} candidates across ${session.retrievals} retrieval${session.retrievals === 1 ? '' : 's'} (${(session.reductionPercent * 100).toFixed(1)}%).`
      : 'This server session: no retrievals yet.';
    const text = `${formatStats(days)}\n\n${current}`;
    return { content: [{ type: 'text', text }], structuredContent: { days, session } };
  });
  return server;
}
