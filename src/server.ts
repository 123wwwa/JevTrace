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
import { RepositoryIndex, discoverEntries } from './discovery.js';
import { formatContextSavings, RetrievalLatencyWindow, summarizeContextSavings } from './context-metrics.js';

const CONTEXT_UI_URI = 'ui://jevtrace/context-savings.html';

export function createServer(root = process.cwd()): McpServer {
  const server = new McpServer({ name: 'jevtrace', version: '0.1.0' });
  const projectRoot = path.resolve(root);
  const adapter = new TypeScriptAdapter(projectRoot);
  const index = new RepositoryIndex(projectRoot);
  const retrievalLatencies = new RetrievalLatencyWindow(50);
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

  registerAppResource(server, 'JevTrace context savings', CONTEXT_UI_URI, {
    title: 'JevTrace Context Savings',
    description: 'Interactive context-reduction and retrieval telemetry for retrieve_dependency_context.',
    mimeType: RESOURCE_MIME_TYPE,
  }, async uri => {
    const html = await readFile(new URL('./context-savings.html', import.meta.url), 'utf8');
    return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });

  registerAppTool(server, 'retrieve_dependency_context', {
    title: 'Retrieve JevTrace context',
    description: 'Primary task-to-context retrieval. Start from the natural-language coding task, run JevTrace repository discovery, expand semantic leads with the TypeScript compiler, and return budgeted implementation context. Do not infer or supply an entry file/line for this tool.',
    _meta: { ui: { resourceUri: CONTEXT_UI_URI } },
    inputSchema: z.object({
      task: z.string().min(1).describe('The coding task, including the intended change or bug'),
      maxCandidates: z.number().int().min(1).max(128).default(64),
      maxLeads: z.number().int().min(1).max(8).default(4),
      maxFiles: z.number().int().min(1).max(10000).default(3000),
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
    }),
  }, async ({ task, tokenBudget, reverseFanIn, perLeadNodeLimit, perLeadTokenBudget, neighborhoodTokenBudget, lexicalMergeLimit, includeLexicalParallel, contextRanking, maxChars, maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles }, context) => {
    try {
      const started = performance.now();
      judge ??= createJudge();
      const result = await serialize(() => query(index, adapter, judge!, task, undefined, {
        tokenBudget, reverseFanIn,
        maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles,
        perLeadNodeLimit, perLeadTokenBudget, neighborhoodTokenBudget,
        lexicalMergeLimit, includeLexicalParallel, contextRanking,
        signal: context.mcpReq.signal,
      }));
      const discoveryText = result.discovery ? `Entry discovery (${result.discovery.mode}): ${result.discovery.selected ? `${result.discovery.selected.file}:${result.discovery.selected.line}` : 'no suitable entry'}\n` : '';
      if ('items' in result) {
        const totalMs = performance.now() - started;
        const latencyStats = retrievalLatencies.record(totalMs);
        const contextSavings = summarizeContextSavings(result, totalMs, latencyStats);
        const savingsText = `${formatContextSavings(contextSavings)}\n`;
        return {
          content: [{ type: 'text', text: (discoveryText + savingsText + formatContext(result, maxChars)).slice(0, maxChars) }],
          structuredContent: { ...result, contextSavings },
        };
      }
      return { content: [{ type: 'text', text: (discoveryText + result.warnings.join('\n')).slice(0, maxChars) }], structuredContent: { ...result } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      const lead = [...(evidence?.leads ?? [])].sort((a, b) => b.score - a.score)[0];
      const entryFile = file ?? evidence?.path;
      if (!entryFile || (line === undefined && !lead && !symbol)) throw new Error('Provide an explicit file with line/symbol, or structured evidence with a lead');
      judge ??= createJudge();
      const result = await serialize(() => query(index, adapter, judge!, task,
        { file: entryFile, line: line ?? lead?.range.startLine, endLine: endLine ?? lead?.range.endLine, symbol: symbol ?? lead?.name, score: lead?.score },
        { maxDepth, maxNodes, tokenBudget, bodyThreshold, omitThreshold, visitPolicy, wrapperLookahead, reverse, reverseFanIn, signal: context.mcpReq.signal }));
      return { content: [{ type: 'text', text: formatContext(result, maxChars).slice(0, maxChars) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  server.registerTool('discover_entries', {
    description: 'Run parallel JS/TS discovery: local BM25F/exact/path RRF plus Jev repository-tree file selection and semantic lead selection.',
    inputSchema: z.object({
      task: z.string().min(1),
      maxCandidates: z.number().int().min(1).max(128).default(64),
      maxLeads: z.number().int().min(1).max(8).default(4),
      maxFiles: z.number().int().min(1).max(10000).default(3000),
      maxJevFiles: z.number().int().min(1).max(1000).default(256),
      maxRelevantDirectories: z.number().int().min(1).max(32).default(8),
      maxRelevantFiles: z.number().int().min(1).max(32).default(8),
    }),
  }, async ({ task, maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles }, context) => {
    try {
      judge ??= createJudge();
      const result = await serialize(() => discoverEntries(index, judge!, task,
        { maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles, signal: context.mcpReq.signal }, adapter));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
