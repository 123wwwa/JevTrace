// Shows what the model is given for each task (the text content; the retrieval tools return no
// structuredContent) and, from the metadata in `_meta`, the returned symbols with level, edge kind and score.
//   node --env-file=.env scripts/agent-view.mjs <project-root> "task one" "task two" ...
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
const [root, ...tasks] = process.argv.slice(2);
const env = { ...getDefaultEnvironment(), OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '', JEVTRACE_USAGE_LOG: 'off' };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), '--root', path.resolve(root)], env, stderr: 'pipe' });
const client = new Client({ name: 'agent-view', version: '1' });
await client.connect(transport);
for (const task of tasks) {
  const result = await client.callTool({ name: 'retrieve_dependency_context', arguments: { task } });
  const s = result._meta?.['jevtrace/result'] ?? {};
  const context = result.content?.map(part => part.type === 'text' ? part.text : '').join('\n') ?? '';
  console.log(`\n==== ${task}\ncontext ${context.length} chars, structuredContent ${result.structuredContent ? 'present' : 'none'}, status ${s.status}, warnings ${JSON.stringify(s.warnings)}`);
  console.log((s.items ?? []).map(item => `  ${item.level.padEnd(9)} ${(item.kind ?? 'lead').padEnd(7)} ${(item.score ?? 0).toFixed(2)} ${item.node.name}  (${item.node.file}:${item.node.startLine}-${item.node.endLine})`).join('\n'));
  console.log('  --- context head ---\n' + context.split('\n').slice(0, 6).map(line => '  ' + line.slice(0, 160)).join('\n'));
}
await client.close();
process.exit(0);
