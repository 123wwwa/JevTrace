import { RepositoryIndex, discoverEntries, type DiscoveryOptions, type DiscoveryResult } from './discovery.js';
import { retrieve, type RetrievalOptions, type RetrievalResult } from './retrieve.js';
import { retrieveTaskContext, type TaskPipelineOptions } from './task-pipeline.js';
import type { BroadTaskResult } from './broad-task.js';
import type { EntryInput, LanguageAdapter, RelevanceJudge } from './types.js';

export type QueryResult = RetrievalResult & { discovery?: DiscoveryResult };
export type IncompleteQueryResult = { status: 'incomplete' | 'not-covered'; task: string; discovery: DiscoveryResult; warnings: string[] };
type QueryOptions = RetrievalOptions & DiscoveryOptions & TaskPipelineOptions;

export function query(index: RepositoryIndex, adapter: LanguageAdapter, judge: RelevanceJudge, task: string,
  input: EntryInput, options?: QueryOptions): Promise<QueryResult>;
export function query(index: RepositoryIndex, adapter: LanguageAdapter, judge: RelevanceJudge, task: string,
  input: undefined, options?: QueryOptions): Promise<QueryResult | IncompleteQueryResult | BroadTaskResult>;
export function query(index: RepositoryIndex, adapter: LanguageAdapter, judge: RelevanceJudge, task: string,
  input: EntryInput | undefined, options?: QueryOptions): Promise<QueryResult | IncompleteQueryResult | BroadTaskResult>;
export async function query(index: RepositoryIndex, adapter: LanguageAdapter, judge: RelevanceJudge, task: string,
  input?: EntryInput, options: QueryOptions = {}): Promise<QueryResult | IncompleteQueryResult | BroadTaskResult> {
  options.signal?.throwIfAborted();
  if (input) return retrieve(adapter, judge, task, input, options);
  return retrieveTaskContext(index, adapter, judge, judge, task, options);
}
