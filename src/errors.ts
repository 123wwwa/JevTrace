/**
 * Turns an error into a message a person can act on: what went wrong in plain words, what to do about it,
 * and the original error for a bug report. Used for MCP tool errors and CLI failures alike.
 */

const issues = 'https://github.com/123wwwa/JevTrace/issues';

/** Errors whose message is already written for the user (no "what happened" prefix needed). */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError';
}

export function explainError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const target = (error as NodeJS.ErrnoException | undefined)?.path;
  const original = `\n\n(${error instanceof Error && error.name !== 'Error' ? `${error.name}: ` : ''}${message})`;

  if (code === 'EPERM' || code === 'EACCES') {
    return `JevTrace could not read ${target ?? 'a file or folder'} (permission denied). Run it on a project folder you own, or register it with --root /path/to/project.${original}`;
  }
  if (code === 'ENOENT') {
    return `JevTrace could not find ${target ?? 'a file or folder'}. If the project moved, restart your agent in its new location.${original}`;
  }
  if (code === 'EMFILE' || code === 'ENFILE') {
    return `Too many files are open at once. Close other programs that watch files, or search a smaller folder with --root.${original}`;
  }

  // Provider responses: "Decision request failed (401): ..."
  const status = Number(/failed \((\d{3})\)/.exec(message)?.[1]);
  if (status === 401 || status === 403) {
    return `The Jev provider rejected the API key. Run \`npx -y jevtrace setup\` in a terminal to enter a new one.${original}`;
  }
  if (status === 402) {
    return `The Jev provider says the account has no credits left. Add credits with the provider, or switch provider with \`npx -y jevtrace setup\`.${original}`;
  }
  if (status === 429) {
    return `The Jev provider is rate limiting requests. Wait a minute and try again.${original}`;
  }
  if (status >= 500) {
    return `The Jev provider is having trouble (HTTP ${status}). Try again in a moment, or switch provider with \`npx -y jevtrace setup\`.${original}`;
  }
  if (status === 400 || status === 404) {
    return `The Jev provider refused the request (HTTP ${status}). If you set a model or endpoint yourself (JEVTRACE_MODEL, JEVTRACE_ENDPOINT), check it; otherwise please report this at ${issues}.${original}`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(message)) {
    return `JevTrace could not reach the Jev provider. Check your internet connection or proxy, then try again.${original}`;
  }
  if (/TimeoutError|timed out|timeout/i.test(message)) {
    return `The Jev provider did not answer in time. Try again; a smaller task or a narrower --root also helps.${original}`;
  }
  if (/No decision provider is configured|No API key for|Several provider keys are set|has no provider; run|Cannot read .*config/.test(message)) {
    return message;
  }
  return `JevTrace hit an unexpected error. Please report it with this message at ${issues}${original}`;
}
