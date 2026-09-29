// Minimal MCP Apps host: shows one dashboard the way a chat host does (sandboxed iframe + AppBridge over
// postMessage), fed with tool results recorded from the real MCP server by scripts/ui-preview.mjs.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

type Theme = 'light' | 'dark';
interface State { label: string; input: Record<string, unknown>; result: any }
interface Recording { uri: string; root: string; online: boolean; viewHtml: string; states: Record<string, State> }

const data = await fetch('./generated/scenarios.json').then(response => response.json() as Promise<Recording>);
document.getElementById('meta')!.textContent = `${data.uri} · ${data.online ? 'online judge' : 'offline judge'}`;

const params = new URLSearchParams(location.search);
let theme: Theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const stateName = params.get('state') ?? 'session';
const state = data.states[stateName] ?? data.states.session;

const select = document.getElementById('state') as HTMLSelectElement;
for (const [name, entry] of Object.entries(data.states)) select.add(new Option(entry.label, name, false, name === stateName));
select.addEventListener('change', () => { params.set('state', select.value); location.search = params.toString(); });

const themeButton = document.getElementById('theme')!;
const applyTheme = () => {
  document.body.classList.toggle('dark', theme === 'dark');
  themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
};
applyTheme();

document.getElementById('message')!.textContent = `retrieve_dependency_context · “${String(state.input.task ?? '')}”`;
const iframe = document.createElement('iframe');
iframe.setAttribute('sandbox', 'allow-scripts');
iframe.title = 'JevTrace dashboard';
iframe.srcdoc = data.viewHtml;
document.getElementById('view')!.append(iframe);

const bridge = new AppBridge(null, { name: 'JevTrace UI host', version: '1.0.0' }, {}, {
  hostContext: { theme, displayMode: 'inline', containerDimensions: { maxWidth: 728 } },
});
bridge.onsizechange = ({ height }) => { if (height) iframe.style.height = `${Math.ceil(height)}px`; };
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: state.input });
  await bridge.sendToolResult(state.result);
  document.body.dataset.rendered = 'true';
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));

themeButton.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  params.set('theme', theme);
  history.replaceState(null, '', `?${params}`);
  applyTheme();
  void bridge.sendHostContextChange({ theme });
});
