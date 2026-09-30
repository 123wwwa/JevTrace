import path from 'node:path';
import { defaultMaxFiles, type RepositoryIndex } from './discovery.js';
import type { JudgeCallStats } from './types.js';

/**
 * Below this task specificity the task is treated as project-wide ("find critical bugs", "scaffold the
 * project", "review security"). Measured with Jev on 27 specific tasks, including the 19 benchmark tasks and
 * Korean ones (0.62–0.93), and 14 broad ones (0.09–0.48, except "Add rate limiting" at 0.64).
 */
export const broadTaskThreshold = 0.5;

/** One area of the repository and the broad task restricted to it, ready to pass back as a task. */
export interface Subtask {
  area: string;
  files: number;
  task: string;
}

/** Returned instead of code when the task names no behaviour a search could locate. */
export interface BroadTaskResult {
  task: string;
  status: 'broad';
  specificity: number;
  /** What happened and how to ask for code instead. */
  guidance: string;
  /** The task split by repository area; each one passes the scope check on its own. */
  subtasks: Subtask[];
  /** Directories with their top-level declarations, for choosing a concrete area. */
  map: string;
  warnings: string[];
  scopeStats: JudgeCallStats;
}

const testFile = /(?:^|[/.])(?:__tests__|test|tests|spec)(?:[/.]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const namesPerDirectory = 6;
const namesPerSubtask = 4;
/** An area this small is not split further. */
const minSplitFiles = 6;

/** Non-test source files with their top-level declaration names, plus the number of test files. */
export interface SourceInventory {
  files: Map<string, string[]>;
  testFiles: number;
}

export function sourceInventory(index: RepositoryIndex, maxFiles = defaultMaxFiles): SourceInventory {
  const { nodes } = index.scan(maxFiles);
  const files = new Map<string, string[]>();
  for (const node of nodes) {
    if (testFile.test(node.file)) continue;
    const names = files.get(node.file) ?? [];
    // A class is indexed through its members (`Class.method`); the map lists the class once.
    const name = node.name.split('.')[0];
    if (!names.includes(name)) names.push(name);
    files.set(node.file, names);
  }
  return { files, testFiles: new Set(nodes.map(node => node.file).filter(file => testFile.test(file))).size };
}

const directoryOf = (file: string): string => {
  const directory = path.posix.dirname(file);
  return directory === '.' ? '' : directory;
};
const label = (directory: string): string => directory ? `${directory}/` : '(root)';
const namesOf = (inventory: SourceInventory, files: string[], limit: number): { shown: string[]; more: number } => {
  const names: string[] = [];
  for (const file of files) for (const name of inventory.files.get(file) ?? []) if (!names.includes(name)) names.push(name);
  return { shown: names.slice(0, limit), more: Math.max(0, names.length - limit) };
};

/**
 * One line per directory: source-file count and top-level declaration names. When that exceeds `maxChars`,
 * directories are merged into their ancestors, deepest level first, until it fits.
 */
export function repositoryMap(inventory: SourceInventory, maxChars: number): string {
  const { files, testFiles } = inventory;
  const deepest = Math.max(1, ...[...files.keys()].map(file => path.posix.dirname(file).split('/').length));
  let body = '';
  for (let depth = deepest; depth >= 1; depth--) {
    const directories = new Map<string, string[]>();
    for (const file of files.keys()) {
      const directory = directoryOf(file).split('/').slice(0, depth).join('/');
      directories.set(directory, [...(directories.get(directory) ?? []), file]);
    }
    body = [...directories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([directory, members]) => {
      const { shown, more } = namesOf(inventory, members, namesPerDirectory);
      return `${label(directory)} — ${members.length} file${members.length === 1 ? '' : 's'}${shown.length ? `: ${shown.join(', ')}${more ? ` (+${more} more)` : ''}` : ''}`;
    }).join('\n');
    if (body.length <= maxChars) break;
  }
  const heading = `Repository map: ${files.size} source files${testFiles ? ` (+${testFiles} test files)` : ''}; top-level declarations per directory.`;
  const text = `${heading}\n${body}`;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 40)).replace(/\n[^\n]*$/, '')}\n… (map truncated)`;
}

/**
 * Splits the repository into at most `max` areas, starting from the root and repeatedly splitting the
 * largest area into its subdirectories (files directly inside it stay as their own area), then restricts the
 * task to each one. "<task> — only in <dir>/ (<names>)" passed the scope check at 0.85–0.95 for every broad
 * task tried, in English and Korean, where prefixing the area instead could still read as project-wide.
 */
export function suggestSubtasks(task: string, inventory: SourceInventory, max = 16): Subtask[] {
  type Area = { directory: string; files: string[] };
  let areas: Area[] = [{ directory: '', files: [...inventory.files.keys()] }];
  const children = (area: Area): Map<string, string[]> => {
    const groups = new Map<string, string[]>();
    for (const file of area.files) {
      const rest = directoryOf(file).slice(area.directory ? area.directory.length + 1 : 0);
      const child = directoryOf(file) === area.directory ? area.directory : [area.directory, rest.split('/')[0]].filter(Boolean).join('/');
      groups.set(child, [...(groups.get(child) ?? []), file]);
    }
    return groups;
  };
  // Only the largest splittable area is split, and splitting stops when it no longer fits: splitting smaller
  // areas instead would leave one huge area next to many tiny ones.
  const fixed = new Set<Area>();
  for (;;) {
    const area = areas.filter(each => !fixed.has(each))
      .sort((a, b) => b.files.length - a.files.length || a.directory.localeCompare(b.directory))[0];
    if (!area) break;
    const groups = children(area);
    const position = areas.indexOf(area);
    if (groups.size === 1) {
      const [only] = groups.keys();
      // Files all directly inside: nothing to split. One subdirectory only: descend without adding an area.
      if (only === area.directory) fixed.add(area);
      else areas[position] = { directory: only, files: area.files };
      continue;
    }
    if (area.files.length < minSplitFiles) { fixed.add(area); continue; }
    if (areas.length - 1 + groups.size > max) break;
    areas = [...areas.slice(0, position), ...[...groups].map(([directory, files]) => ({ directory, files })), ...areas.slice(position + 1)];
  }
  return areas.filter(area => area.files.length)
    .sort((a, b) => a.directory.localeCompare(b.directory))
    .map(area => {
      const { shown } = namesOf(inventory, area.files, namesPerSubtask);
      const nested = areas.some(other => other !== area && other.directory.startsWith(`${area.directory}/`)) || (!area.directory && areas.length > 1);
      const where = nested ? `${label(area.directory)} (files directly in it)` : label(area.directory);
      return { area: where, files: area.files.length, task: `${task} — only in ${where}${shown.length ? ` (${shown.join(', ')})` : ''}` };
    });
}

export function broadTaskGuidance(specificity: number, subtasks: Subtask[]): string {
  return [
    `This task reads as project-wide rather than about one behaviour (task specificity ${specificity.toFixed(2)} < ${broadTaskThreshold}), so JevTrace returned no code: any slice it picked would be arbitrary.`,
    'Split it by area: call retrieve_dependency_context once for each area you need to cover, passing one line below as the task (or narrow it further to one behaviour). To retrieve for this exact wording anyway, call again with scopeCheck: false.',
    '',
    'Suggested subtasks:',
    ...subtasks.map(subtask => `- ${subtask.task}   [${subtask.files} source file${subtask.files === 1 ? '' : 's'}]`),
  ].join('\n');
}
