import { RepositoryIndex, discoverEntries, type DiscoveryOptions, type DiscoveryResult } from './discovery.js';
import { retrieve, type RetrievalOptions, type RetrievalResult } from './retrieve.js';
import { retrieveTaskContext, type TaskPipelineOptions } from './task-pipeline.js';
import type { EntryInput, LanguageAdapter, RelevanceJudge } from './types.js';

export type QueryResult = RetrievalResult & { discovery?: DiscoveryResult };

export async function query(index: RepositoryIndex, adapter: LanguageAdapter, judge: RelevanceJudge, task: string,
  input?: EntryInput, options: RetrievalOptions & DiscoveryOptions & TaskPipelineOptions = {}): Promise<QueryResult | { status: 'incomplete'; task: string; discovery: DiscoveryResult; warnings: string[] }> {
  options.signal?.throwIfAborted();
  if (input) return retrieve(adapter, judge, task, input, options);
  return retrieveTaskContext(index, adapter, judge, judge, task, options);
}
