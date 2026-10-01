import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Errors that mean "this folder cannot be listed", not "something is broken". */
const unreadable = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'ELOOP']);

/**
 * Lists a directory, or returns nothing for one that cannot be read: folders the OS protects (macOS keeps
 * ~/Library/Accounts and similar behind privacy permissions), folders deleted while a walk runs, broken links.
 * A walk over a whole project used to stop at the first such folder. Unreadable folders are added to
 * `skipped` so the caller can say what it left out.
 */
export function readDirectory(directory: string, skipped?: string[]): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (unreadable.has((error as NodeJS.ErrnoException).code ?? '')) {
      skipped?.push(directory);
      return [];
    }
    throw error;
  }
}

/** "Skipped 2 folders that could not be read: Library/Accounts, Library/Mail" */
export function describeSkipped(root: string, skipped: string[]): string | undefined {
  if (!skipped.length) return undefined;
  const shown = skipped.slice(0, 3).map(directory => path.relative(root, directory).replaceAll('\\', '/') || '.').join(', ');
  return `Skipped ${skipped.length} folder${skipped.length === 1 ? '' : 's'} that could not be read: ${shown}${skipped.length > 3 ? `, +${skipped.length - 3} more` : ''}`;
}

/**
 * Why `root` is not a project JevTrace should search, or undefined when it is fine. A home directory or a
 * filesystem root is what a client passes when the agent was started outside any project; searching it walks
 * every file the user owns.
 */
export function unsuitableRoot(root: string): string | undefined {
  const resolved = path.resolve(root);
  const where = resolved === path.parse(resolved).root ? 'the filesystem root' : resolved === path.resolve(os.homedir()) ? 'your home directory' : undefined;
  if (!where) return undefined;
  return [
    `JevTrace was started in ${where} (${resolved}), not in a project, so it has nothing to search.`,
    'It searches the folder your agent runs in: start the agent from a JS/TS project folder,',
    'or register JevTrace for one project with --root, e.g.',
    '  claude mcp add jevtrace --scope user -- npx -y jevtrace --root /path/to/project',
    'Setup for Codex and Cursor: https://github.com/123wwwa/JevTrace/blob/main/docs/clients.md',
  ].join('\n');
}
