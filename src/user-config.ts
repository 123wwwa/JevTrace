import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The decision provider chosen with `jevtrace setup`, so the CLI and MCP server work without a `.env` file.
 * Environment variables still take precedence. Set JEVTRACE_CONFIG to a file path to move it, or to `off` to
 * ignore it (tests do).
 */
export interface UserConfig {
  /** A registered provider name, or `custom`. */
  provider: string;
  apiKey?: string;
  model?: string;
  /** Required for `custom`; overrides a registered provider's endpoint otherwise. */
  endpoint?: string;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.JEVTRACE_CONFIG;
  if (configured === 'off') return undefined;
  return configured || path.join(os.homedir(), '.jevtrace', 'config.json');
}

export function readUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig | undefined {
  const file = userConfigPath(env);
  if (!file || !fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}; run \`jevtrace setup\` again`);
  }
  const config = parsed as Partial<UserConfig>;
  if (!config || typeof config.provider !== 'string') throw new Error(`${file} has no provider; run \`jevtrace setup\` again`);
  return {
    provider: config.provider,
    ...(typeof config.apiKey === 'string' ? { apiKey: config.apiKey } : {}),
    ...(typeof config.model === 'string' ? { model: config.model } : {}),
    ...(typeof config.endpoint === 'string' ? { endpoint: config.endpoint } : {}),
  };
}

/** Writes the config readable by the current user only (on Windows the file inherits the profile folder's access). */
export function writeUserConfig(config: UserConfig, env: NodeJS.ProcessEnv = process.env): string {
  const file = userConfigPath(env);
  if (!file) throw new Error('JEVTRACE_CONFIG=off: there is no config file to write');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
