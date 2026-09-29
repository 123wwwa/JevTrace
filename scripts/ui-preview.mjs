// Records real retrieve_dependency_context results from the stdio MCP server, plus the dashboard HTML it
// serves, for the MCP Apps test host in test/ui-host. The HTML is inlined in JSON because a dev server
// would rewrite a served .html file. Usage:
//   node scripts/ui-preview.mjs [--root ../hono] [--online]
// Offline (default) uses the include-all judge; --online uses the provider configured in the environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const root = path.resolve(arg('--root') ?? path.join(projectRoot, '..', 'hono'));
const online = process.argv.includes('--online');
const outDir = path.join(projectRoot, 'test', 'ui-host', 'generated');

const providerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(JEVTRACE_|OPENROUTER_|TYPESAFE_|AI_GATEWAY_|OPENCODE_)/.test(key)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'dist', 'cli.js'), '--root', root],
  env: { ...getDefaultEnvironment(), ...(online ? providerEnv : { JEVTRACE_JUDGE: 'include-all' }) },
  stderr: 'inherit',
});
const client = new Client({ name: 'jevtrace-ui-preview', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const uri = tools.find(tool => tool.name === 'retrieve_dependency_context')?._meta?.ui?.resourceUri;
if (!uri) throw new Error('retrieve_dependency_context does not declare a UI resource');
const view = await client.readResource({ uri });

const call = async task => {
  const input = { task };
  return { input, result: await client.callTool({ name: 'retrieve_dependency_context', arguments: input }) };
};
const tasks = [
  'Change how the CORS middleware handles preflight requests when the allowed origin is a function',
  'Conditional GET requests should answer Not Modified when any client validator matches',
  'Allow a configurable clock-skew tolerance when checking whether a bearer token is expired',
  'Cookies written with the host-bound name prefix must drop any domain and force the Secure flag',
  'Let the per-request deadline middleware compute its duration from the incoming request',
  'Network-range allow rules written for IPv4 should also match IPv4-mapped IPv6 clients',
];
const runs = [];
for (const task of tasks) runs.push(await call(task));
const noContext = await call('zzqx wobble frobnicate plinth');
await client.close();

// One dashboard per state, the way a host shows one view per tool call.
const states = {
  session: { label: `After ${runs.length} retrievals`, ...runs.at(-1) },
  first: { label: 'First retrieval', ...runs[0] },
  noContext: { label: 'No relevant code found', ...noContext },
  error: { label: 'Tool error', input: { task: 'refresh token' },
    result: { isError: true, content: [{ type: 'text', text: 'OPENROUTER_API_KEY is required for the openrouter Jev provider' }] } },
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'scenarios.json'), JSON.stringify({ uri, root, online, viewHtml: view.contents[0].text, states }, null, 2));
console.log(`Recorded ${runs.length + 1} retrievals from ${root} (${online ? 'online' : 'offline'}) into ${path.relative(projectRoot, outDir)}`);
