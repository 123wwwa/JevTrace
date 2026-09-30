import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { JevBackend, providers, type ProviderSpec } from './decision-backends.js';
import { DecisionJudge } from './judges.js';
import { readUserConfig, userConfigPath, writeUserConfig, type UserConfig } from './user-config.js';

/**
 * `jevtrace setup`: choose the decision provider, enter its API key (hidden while typed), optionally a model,
 * check the key with one small request, and save it to the user config. Also reads answers line by line from
 * a pipe, for scripts.
 */

/** Setup for each MCP client (docs/clients.md). */
export const clientsGuide = 'https://github.com/123wwwa/JevTrace/blob/main/docs/clients.md';

type Input = NodeJS.ReadStream;
type Output = NodeJS.WritableStream;

class Prompter {
  private lines?: AsyncIterator<string>;
  constructor(private readonly input: Input, private readonly output: Output) {}

  async line(question: string): Promise<string> {
    this.output.write(question);
    if (this.input.isTTY) {
      const rl = readline.createInterface({ input: this.input, terminal: false });
      try {
        return await new Promise<string>((resolve, reject) => {
          rl.once('line', answer => resolve(answer.trim()));
          rl.once('close', () => reject(new Error('Setup cancelled')));
        });
      } finally {
        rl.removeAllListeners('close');
        rl.close();
      }
    }
    this.lines ??= readline.createInterface({ input: this.input, terminal: false })[Symbol.asyncIterator]();
    const next = await this.lines.next();
    if (next.done) throw new Error('Setup input ended before every answer was given');
    this.output.write('\n');
    return next.value.trim();
  }

  /** Echoes one `*` per character; the key itself never reaches the screen. */
  async hidden(question: string): Promise<string> {
    if (!this.input.isTTY) return this.line(question);
    this.output.write(question);
    const input = this.input;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    return new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = () => {
        input.off('data', onData);
        input.setRawMode(false);
        input.pause();
        this.output.write('\n');
      };
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === '\r' || character === '\n') { finish(); resolve(value.trim()); return; }
          if (character === '\u0003') { finish(); reject(new Error('Setup cancelled')); return; }
          if (character === '\u007f' || character === '\b') {
            if (value) { value = value.slice(0, -1); this.output.write('\b \b'); }
            continue;
          }
          if (character < ' ') continue;
          value += character;
          this.output.write('*');
        }
      };
      input.on('data', onData);
    });
  }
}

type Choice = { name: string; label: string; spec?: ProviderSpec };

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  input?: Input;
  output?: Output;
  /** Checks the key with one request; tests replace it. Resolves to an error message, or undefined when it works. */
  verify?: (config: UserConfig) => Promise<string | undefined>;
}

async function verifyConfig(config: UserConfig): Promise<string | undefined> {
  const spec = config.provider === 'custom' ? undefined : providers[config.provider as keyof typeof providers];
  const endpoint = config.endpoint ?? spec?.endpoint;
  if (!endpoint) return 'No endpoint';
  const backend = spec ? spec.createBackend({ endpoint, apiKey: config.apiKey ?? '' }) : new JevBackend(endpoint, config.apiKey ?? '');
  const judge = new DecisionJudge(backend, config.model ?? spec?.model ?? 'jev-latest');
  try {
    const result = await judge.judgeTaskScope('Fix the redirect after a failed login');
    return result.specificity === undefined ? 'The provider answered, but not with a valid decision' : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runSetup(options: SetupOptions = {}): Promise<UserConfig> {
  const env = options.env ?? process.env;
  const output = options.output ?? process.stdout;
  const prompt = new Prompter(options.input ?? process.stdin, output);
  const verify = options.verify ?? verifyConfig;
  const current = (() => { try { return readUserConfig(env); } catch { return undefined; } })();

  // Alphabetical: no provider is presented as the default.
  const choices: Choice[] = [
    ...(Object.entries(providers) as Array<[string, ProviderSpec]>)
      .map(([name, spec]) => ({ name, label: spec.label, spec }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { name: 'custom', label: 'Custom endpoint (Jev System One format)' },
  ];
  output.write('JevTrace setup: choose the decision provider that judges which code is relevant.\n\n');
  choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label.padEnd(40)}${choice.spec ? ` ${choice.spec.keyEnv}` : ''}\n`));
  if (!(options.input ?? process.stdin).isTTY) output.write('\n(Input is not a terminal: answers are read line by line and the key is not hidden.)\n');

  const currentIndex = current ? choices.findIndex(choice => choice.name === current.provider) : -1;
  let choice: Choice | undefined;
  while (!choice) {
    const answer = await prompt.line(`\nProvider [1-${choices.length}]${currentIndex >= 0 ? ` (Enter keeps ${choices[currentIndex].label})` : ''}: `);
    if (!answer && currentIndex >= 0) choice = choices[currentIndex];
    else choice = choices[Number(answer) - 1] ?? choices.find(each => each.name === answer.toLowerCase());
    if (!choice) output.write(`Enter a number from 1 to ${choices.length}.\n`);
  }

  const kept = current?.provider === choice.name ? current : undefined;
  let endpoint: string | undefined;
  if (!choice.spec) {
    while (!endpoint) {
      const answer = await prompt.line(`Endpoint URL${kept?.endpoint ? ` [${kept.endpoint}]` : ''}: `);
      endpoint = answer || kept?.endpoint;
      if (endpoint && !/^https?:\/\//.test(endpoint)) { output.write('Enter an http(s) URL.\n'); endpoint = undefined; }
    }
  }
  const defaultModel = kept?.model ?? choice.spec?.model ?? 'jev-latest';

  for (;;) {
    let apiKey: string | undefined;
    while (apiKey === undefined) {
      const hidden = (options.input ?? process.stdin).isTTY ? 'hidden' : 'from input';
      const answer = await prompt.hidden(`API key${choice.spec ? ` for ${choice.label}` : ''} (${hidden}${kept?.apiKey ? '; Enter keeps the saved key' : ''}): `);
      apiKey = answer || kept?.apiKey;
      if (!apiKey && choice.spec) { output.write('An API key is required.\n'); apiKey = undefined; }
      apiKey ??= choice.spec ? undefined : '';
    }
    const model = (await prompt.line(`Model [${defaultModel}]: `)) || defaultModel;
    const config: UserConfig = {
      provider: choice.name,
      ...(apiKey ? { apiKey } : {}),
      ...(model !== choice.spec?.model ? { model } : {}),
      ...(endpoint ? { endpoint } : {}),
    };

    output.write('Checking the key with one small request... ');
    const started = performance.now();
    const failure = await verify(config);
    if (!failure) {
      output.write(`ok (${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
      const file = writeUserConfig(config, env);
      // The npx form, not this script's path: under npx that path is a cache directory that can disappear.
      output.write([
        `Saved to ${file}. Environment variables (${choice.spec?.keyEnv ?? 'JEVTRACE_API_KEY'}, JEVTRACE_PROVIDER) still override it.`,
        '',
        'Next:',
        '  Claude Code:     claude mcp add jevtrace --scope user -- npx -y jevtrace',
        `  Codex, Cursor:   ${clientsGuide}`,
        '  Try it:          npx -y jevtrace query --root /path/to/project --task "Describe the change"',
        '',
      ].join('\n'));
      return config;
    }
    output.write(`failed\n  ${failure}\n`);
    const again = (await prompt.line('Enter the key again? [Y/n] (n saves it anyway): ')).toLowerCase();
    if (again === 'n' || again === 'no') {
      const file = writeUserConfig(config, env);
      output.write(`Saved to ${file} without a working check.\n`);
      return config;
    }
  }
}

/** Whether a provider is configured anywhere (flag, environment or config), without building a judge. */
export function configuredProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JEVTRACE_PROVIDER || env.JEVTRACE_JUDGE) return true;
  if (Object.values(providers).some(spec => env[spec.keyEnv])) return true;
  try { return readUserConfig(env) !== undefined; } catch { return true; }
}

export { userConfigPath };
