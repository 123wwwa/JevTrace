import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TypeScriptAdapter } from './typescript-adapter.js';
import { createJudge } from './judges.js';
import { formatContext } from './retrieve.js';
import { query } from './query.js';
import { RepositoryIndex, discoverEntries } from './discovery.js';

export function createServer(root = process.cwd()): McpServer {
  const server = new McpServer({ name: 'jevtrace', version: '0.1.0' });
  const projectRoot = path.resolve(root);
  const adapter = new TypeScriptAdapter(projectRoot);
  const index = new RepositoryIndex(projectRoot);
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
    description: 'Find an implementation entry from a task, or use an explicit source location or lead; follow typed dependencies and return budgeted context. Discovery exposes ranked entry leads and coverage limits.',
    inputSchema: z.object({
      task: z.string().min(1).describe('The coding task, including the intended change or bug'),
      maxCandidates: z.number().int().min(1).max(128).default(64),
      maxLeads: z.number().int().min(1).max(8).default(4),
      maxFiles: z.number().int().min(1).max(10000).default(3000),
      maxJevFiles: z.number().int().min(1).max(1000).default(256),
      maxRelevantDirectories: z.number().int().min(1).max(32).default(8),
      maxRelevantFiles: z.number().int().min(1).max(32).default(8),
      file: z.string().min(1).optional().describe('Entry file path relative to the project root'),
      line: z.number().int().positive().optional().describe('Line inside the entry declaration'),
      endLine: z.number().int().positive().optional(),
      symbol: z.string().min(1).optional().describe('Compatibility fallback when a line is unavailable'),
      evidence: z.object({
        path: z.string(),
        leads: z.array(z.object({ name: z.string(), range: z.object({ startLine: z.number(), endLine: z.number() }), score: z.number() })),
      }).optional().describe('Structured lead evidence; highest-scoring lead is used'),
      maxDepth: z.number().int().min(0).max(6).default(4),
      maxNodes: z.number().int().min(1).max(100).default(30),
      tokenBudget: z.number().int().min(500).max(100000).default(8000),
      bodyThreshold: z.number().min(0).max(1).default(0.3),
      omitThreshold: z.number().min(0).max(1).default(0.3),
      visitPolicy: z.enum(['score', 'choice']).default('score'),
      wrapperLookahead: z.boolean().default(true),
      reverse: z.boolean().default(true),
      reverseFanIn: z.number().int().min(1).max(100).default(12),
      perLeadNodeLimit: z.number().int().min(1).max(100).default(24),
      perLeadTokenBudget: z.number().int().min(100).max(100000).optional(),
      neighborhoodTokenBudget: z.number().int().min(500).max(200000).optional(),
      lexicalMergeLimit: z.number().int().min(0).max(128).default(64),
      includeLexicalParallel: z.boolean().default(false),
      contextRanking: z.enum(['jev', 'structural']).default('jev'),
      maxChars: z.number().int().min(1000).max(100000).default(30000),
    }),
  }, async ({ task, file, line, endLine, symbol, evidence, maxDepth, maxNodes, tokenBudget, bodyThreshold, omitThreshold, visitPolicy, wrapperLookahead, reverse, reverseFanIn, perLeadNodeLimit, perLeadTokenBudget, neighborhoodTokenBudget, lexicalMergeLimit, includeLexicalParallel, contextRanking, maxChars, maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles }, context) => {
    try {
      const lead = [...(evidence?.leads ?? [])].sort((a, b) => b.score - a.score)[0];
      const entryFile = file ?? evidence?.path;
      if ((entryFile && line === undefined && !lead && !symbol) || (!entryFile && (line !== undefined || endLine !== undefined || symbol || evidence))) throw new Error('Provide task alone, file and line, file and symbol, or evidence with leads');
      judge ??= createJudge();
      const result = await serialize(() => query(index, adapter, judge!, task,
        entryFile ? { file: entryFile, line: line ?? lead?.range.startLine, endLine: endLine ?? lead?.range.endLine, symbol: symbol ?? lead?.name, score: lead?.score } : undefined,
        { maxDepth, maxNodes, tokenBudget, bodyThreshold, omitThreshold, visitPolicy, wrapperLookahead, reverse, reverseFanIn,
          maxCandidates, maxLeads, maxFiles, maxJevFiles, maxRelevantDirectories, maxRelevantFiles, perLeadNodeLimit, perLeadTokenBudget, neighborhoodTokenBudget,
          lexicalMergeLimit, includeLexicalParallel, contextRanking,
          signal: context.mcpReq.signal }));
      const discoveryText = result.discovery ? `Entry discovery (${result.discovery.mode}): ${result.discovery.selected ? `${result.discovery.selected.file}:${result.discovery.selected.line}` : 'no suitable entry'}\n` : '';
      return { content: [{ type: 'text', text: (discoveryText + ('items' in result ? formatContext(result, maxChars) : result.warnings.join('\n'))).slice(0, maxChars) }], structuredContent: { ...result } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: 'text', text: message }] };
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
