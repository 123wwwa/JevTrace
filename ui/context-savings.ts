import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';

type Point = [retrieval: number, candidateTokens: number, returnedTokens: number];

interface Session {
  retrievals: number;
  candidateTokens: number;
  returnedTokens: number;
  savedTokens: number;
  reductionPercent: number;
  points?: Point[];
}

interface Savings {
  available: boolean;
  candidateTokens?: number;
  returnedTokens: number;
  savedTokens?: number;
  reductionPercent?: number;
  tokenBudget: number;
  returnedSymbols: number;
  candidateSymbols?: number;
  providerRequests: number;
  stage4Applied?: boolean;
  totalMs: number;
  session?: Session;
  status: 'complete' | 'incomplete';
  warningCount: number;
}

interface ViewPayload {
  task?: string;
  warnings?: string[];
  contextSavings?: Savings;
  /** Present when no context was found for the task. */
  session?: Session;
}

const root = document.getElementById('app')!;
const app = new App({ name: 'JevTrace Context Savings', version: '0.2.0' });

// Tokens follow the dataviz reference palette: one accent series (slot 1) against a gray comparison,
// with light and dark steps chosen separately. The host theme (data-theme) wins over the OS preference.
const css = `
  :root {
    color-scheme: light;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    --surface: #fcfcfb;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,.10);
    --accent: #2a78d6;
    --compare: #898781;
    --error: #b3261e;
    --shadow: 0 8px 24px rgba(11,11,11,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,.10);
      --accent: #3987e5; --compare: #898781; --error: #f2b8b5; --shadow: none;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,.10);
    --accent: #3987e5; --compare: #898781; --error: #f2b8b5; --shadow: none;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent; color: var(--ink); }
  .card { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px 22px 16px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .eyebrow { font-size: 12px; color: var(--ink-2); font-weight: 600; }
  .hero { margin-top: 6px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .hero-number { font-size: 52px; line-height: 1; font-weight: 700; letter-spacing: -.02em; }
  .hero-unit { font-size: 16px; color: var(--ink-2); font-weight: 600; }
  .hero-sub { margin-top: 8px; font-size: 13px; color: var(--ink-2); }
  .details-button {
    font: inherit; font-size: 12px; color: var(--ink-2); background: transparent; cursor: pointer;
    border: 1px solid var(--border); border-radius: 999px; padding: 5px 11px; white-space: nowrap;
  }
  .details-button:hover, .details-button[aria-expanded="true"] { color: var(--ink); border-color: var(--axis); }
  .popover {
    position: absolute; top: 52px; right: 16px; z-index: 5; width: min(320px, calc(100% - 32px));
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
    padding: 12px 14px; font-size: 12px;
  }
  .popover[hidden] { display: none; }
  .popover-title { font-weight: 650; margin-bottom: 2px; }
  .popover-task { color: var(--ink-2); margin-bottom: 8px; line-height: 1.4; }
  .popover dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 0; }
  .popover dt { color: var(--ink-2); }
  .popover dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .chart { margin-top: 18px; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend[hidden] { display: none; }
  .key { width: 16px; height: 0; border-top: 2px solid var(--accent); }
  .key.compare { border-top: 2px dashed var(--compare); }
  .key.saved { height: 10px; border: 0; border-radius: 2px; background: var(--accent); opacity: .12; }
  svg { display: block; width: 100%; overflow: visible; }
  svg:focus { outline: none; }
  svg:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
  .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .end-label { font-size: 12px; fill: var(--ink); font-weight: 600; }
  .end-sub { font-size: 11px; fill: var(--ink-2); }
  .gap-label { font-size: 11px; fill: var(--ink-2); font-weight: 600; }
  .tooltip {
    position: absolute; pointer-events: none; z-index: 4; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; box-shadow: var(--shadow); padding: 8px 10px; font-size: 12px; min-width: 150px;
  }
  .tooltip[hidden] { display: none; }
  .tooltip-title { color: var(--ink-2); margin-bottom: 4px; }
  .tooltip-row { display: flex; align-items: center; gap: 8px; }
  .tooltip-row strong { margin-left: auto; font-variant-numeric: tabular-nums; }
  .bars { display: grid; grid-template-columns: auto 1fr auto; gap: 10px 12px; align-items: center; font-size: 12px; margin-top: 18px; }
  .bars .label { color: var(--ink-2); }
  .bars .track { height: 20px; }
  .bars .bar { height: 100%; border-radius: 0 4px 4px 0; }
  .bars .value { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .notice { margin-top: 14px; font-size: 13px; color: var(--ink-2); line-height: 1.5; }
  .notice strong { color: var(--ink); font-weight: 600; }
  .error-title { margin-top: 6px; font-size: 15px; font-weight: 650; color: var(--error); }
  .error-body { margin-top: 6px; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .footnote { margin-top: 12px; font-size: 11px; color: var(--muted); }
  .loading { padding: 18px; font-size: 13px; color: var(--ink-2); }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const esc = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const integer = (value: number | undefined): string => value === undefined ? '—' : Math.round(value).toLocaleString();
const pct = (value: number | undefined): string => value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const compact = (value: number): string => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M`
  : value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(Math.round(value));
const SVG = 'http://www.w3.org/2000/svg';
const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
};

let current: ViewPayload | undefined;

function heroHtml(session: Session | undefined): string {
  if (!session?.retrievals) {
    return `<div class="hero"><span class="hero-number">0</span><span class="hero-unit">tokens saved</span></div>
      <div class="hero-sub">No task-only retrievals yet in this session.</div>`;
  }
  return `<div class="hero"><span class="hero-number">${integer(session.savedTokens)}</span><span class="hero-unit">tokens saved</span></div>
    <div class="hero-sub">${pct(session.reductionPercent)} less context than sending every compiler candidate ·
      ${integer(session.retrievals)} ${session.retrievals === 1 ? 'retrieval' : 'retrievals'}</div>`;
}

function detailsHtml(payload: ViewPayload): string {
  const s = payload.contextSavings;
  if (!s) return '';
  const rows: Array<[string, string]> = [
    ['Candidate pool', `${integer(s.candidateTokens)} tokens`],
    ['Sent to the agent', `${integer(s.returnedTokens)} of ${integer(s.tokenBudget)}`],
    ['Saved', `${integer(s.savedTokens)} (${pct(s.reductionPercent)})`],
    ['Symbols', `${integer(s.returnedSymbols)} of ${integer(s.candidateSymbols)}`],
    ['Provider requests', integer(s.providerRequests)],
    ['Context ranking', s.stage4Applied ? 'applied' : 'not needed'],
    ['Time', `${integer(s.totalMs)} ms`],
    ['Status', s.warningCount ? `${s.status}, ${integer(s.warningCount)} warnings` : s.status],
  ];
  return `
    <button class="details-button" type="button" aria-expanded="false" aria-controls="details">Details</button>
    <div class="popover" id="details" role="dialog" aria-label="Latest retrieval details" hidden>
      <div class="popover-title">Latest retrieval</div>
      <div class="popover-task">${esc(payload.task ?? '')}</div>
      <dl>${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    </div>`;
}

function wireDetails(): void {
  const button = root.querySelector<HTMLButtonElement>('.details-button');
  const popover = root.querySelector<HTMLElement>('.popover');
  if (!button || !popover) return;
  const setOpen = (open: boolean) => {
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    void app.sendSizeChanged({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  };
  button.addEventListener('click', event => { event.stopPropagation(); setOpen(popover.hidden !== false); });
  document.addEventListener('click', event => { if (!popover.hidden && !popover.contains(event.target as Node)) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !popover.hidden) { setOpen(false); button.focus(); } });
}

/** With one retrieval a curve says nothing: compare the two totals as bars instead. */
function renderBars(container: HTMLElement, session: Session): void {
  const max = Math.max(session.candidateTokens, 1);
  container.innerHTML = `
    <div class="bars" role="img" aria-label="Without JevTrace ${integer(session.candidateTokens)} tokens; sent to the agent ${integer(session.returnedTokens)} tokens">
      <span class="label">Without JevTrace</span>
      <div class="track"><div class="bar" style="width:${session.candidateTokens / max * 100}%;background:var(--compare);opacity:.55"></div></div>
      <span class="value">${integer(session.candidateTokens)}</span>
      <span class="label">Sent to the agent</span>
      <div class="track"><div class="bar" style="width:${Math.max(session.returnedTokens / max * 100, .5)}%;background:var(--accent)"></div></div>
      <span class="value">${integer(session.returnedTokens)}</span>
    </div>`;
}

function niceMax(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  return [1, 2, 2.5, 5, 10].map(step => step * magnitude).find(candidate => candidate >= value) ?? value;
}

/** Cumulative tokens without JevTrace (dashed gray) versus sent to the agent (accent); the gap is what was saved. */
function renderCurve(container: HTMLElement, session: Session): void {
  const points: Point[] = [[0, 0, 0], ...(session.points ?? [])];
  const width = Math.max(container.clientWidth, 260);
  const height = 190;
  const pad = { top: 10, right: 96, bottom: 24, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const lastX = points.at(-1)![0];
  const yMax = niceMax(points.at(-1)![1]);
  const x = (value: number) => pad.left + value / Math.max(lastX, 1) * plotW;
  const y = (value: number) => pad.top + plotH - value / yMax * plotH;

  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, height, tabindex: 0, role: 'img',
    'aria-label': `Cumulative tokens over ${session.retrievals} retrievals: ${integer(session.candidateTokens)} without JevTrace, ${integer(session.returnedTokens)} sent to the agent, ${integer(session.savedTokens)} saved. Use the arrow keys to read each retrieval.` });

  for (let step = 0; step <= 4; step++) {
    const value = yMax * step / 4;
    svg.append(svgNode('line', { x1: pad.left, x2: pad.left + plotW, y1: y(value), y2: y(value), stroke: step ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }));
    svg.append(svgNode('text', { class: 'tick', x: pad.left - 8, y: y(value) + 4, 'text-anchor': 'end' }, compact(value)));
  }
  const xTicks = [...new Set([1, Math.round(lastX / 2), lastX])].filter(tick => tick >= 1);
  for (const tick of xTicks) svg.append(svgNode('text', { class: 'tick', x: x(tick), y: height - 6, 'text-anchor': 'middle' }, `#${tick}`));

  const path = (index: 1 | 2) => points.map(([retrieval, ...values], i) => `${i ? 'L' : 'M'}${x(retrieval).toFixed(1)},${y(values[index - 1]).toFixed(1)}`).join('');
  const gap = `${path(1)}${[...points].reverse().map(([retrieval, , returned]) => `L${x(retrieval).toFixed(1)},${y(returned).toFixed(1)}`).join('')}Z`;
  svg.append(svgNode('path', { d: gap, fill: 'var(--accent)', opacity: 0.12 }));
  svg.append(svgNode('path', { d: path(1), fill: 'none', stroke: 'var(--compare)', 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(svgNode('path', { d: path(2), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  const [, candidateEnd, returnedEnd] = points.at(-1)!;
  for (const [value, color, label] of [[candidateEnd, 'var(--compare)', 'without'], [returnedEnd, 'var(--accent)', 'sent']] as const) {
    svg.append(svgNode('circle', { cx: x(lastX), cy: y(value), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.append(svgNode('text', { class: 'end-label', x: x(lastX) + 10, y: y(value) + 1 }, compact(value)));
    svg.append(svgNode('text', { class: 'end-sub', x: x(lastX) + 10, y: y(value) + 14 }, label));
  }
  // Keep the two end labels from colliding when the curves end close together.
  const labels = [...svg.querySelectorAll<SVGTextElement>('.end-label, .end-sub')];
  if (Math.abs(y(candidateEnd) - y(returnedEnd)) < 30) for (const [index, label] of labels.entries()) if (index >= 2) label.setAttribute('y', String(Number(label.getAttribute('y')) + 30 - Math.abs(y(candidateEnd) - y(returnedEnd))));
  const midGap = (y(candidateEnd) + y(returnedEnd)) / 2;
  // The in-gap label needs room between the curves; on narrow charts the hero and tooltip carry the value.
  if (y(returnedEnd) - y(candidateEnd) > 22 && plotW >= 360) svg.append(svgNode('text', { class: 'gap-label', x: x(lastX) - 8, y: midGap + 4, 'text-anchor': 'end' }, `${compact(session.savedTokens)} saved`));

  const cross = svgNode('line', { y1: pad.top, y2: pad.top + plotH, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  container.replaceChildren(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.hidden = true;
  container.style.position = 'relative';
  container.append(tooltip);
  const show = (index: number) => {
    const [retrieval, candidate, returned] = points[index];
    cross.setAttribute('x1', String(x(retrieval)));
    cross.setAttribute('x2', String(x(retrieval)));
    cross.setAttribute('visibility', 'visible');
    const rows: Array<[string, number, string]> = [['Saved', candidate - returned, ''], ['Without JevTrace', candidate, 'compare'], ['Sent to the agent', returned, 'sent']];
    tooltip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tooltip-title';
    title.textContent = retrieval ? `After retrieval #${retrieval}` : 'Start of session';
    tooltip.append(title);
    for (const [name, value, key] of rows) {
      const row = document.createElement('div');
      row.className = 'tooltip-row';
      const swatch = document.createElement('span');
      swatch.className = key === 'compare' ? 'key compare' : key === 'sent' ? 'key' : 'key saved';
      const label = document.createElement('span');
      label.textContent = name;
      const strong = document.createElement('strong');
      strong.textContent = integer(value);
      row.append(swatch, label, strong);
      tooltip.append(row);
    }
    tooltip.hidden = false;
    const left = x(retrieval) / width * container.clientWidth;
    tooltip.style.left = `${Math.min(Math.max(left + 12, 0), container.clientWidth - tooltip.offsetWidth)}px`;
    tooltip.style.top = `${pad.top}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tooltip.hidden = true; };
  let focused = points.length - 1;
  svg.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width * width;
    focused = points.reduce((best, point, index) => Math.abs(x(point[0]) - px) < Math.abs(x(points[best][0]) - px) ? index : best, 0);
    show(focused);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(focused));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    focused = Math.min(Math.max(focused + (event.key === 'ArrowRight' ? 1 : -1), 0), points.length - 1);
    show(focused);
  });
}

function renderChart(session: Session | undefined): void {
  const container = root.querySelector<HTMLElement>('.chart-body');
  if (!container || !session?.retrievals) return;
  const bars = session.retrievals < 2 || (session.points?.length ?? 0) < 2;
  // Bars carry their own labels; the line-key legend only describes the curve.
  const legend = root.querySelector<HTMLElement>('.legend');
  if (legend) legend.hidden = bars;
  if (bars) renderBars(container, session);
  else renderCurve(container, session);
}

function render(payload: ViewPayload): void {
  current = payload;
  const session = payload.contextSavings?.session ?? payload.session;
  const noContext = !payload.contextSavings;
  root.innerHTML = `
    <section class="card">
      <div class="top">
        <div class="eyebrow">JevTrace · context saved this session</div>
        ${detailsHtml(payload)}
      </div>
      ${heroHtml(session)}
      ${noContext ? `<div class="notice"><strong>No relevant code was found for the latest task.</strong>
        Try naming the behaviour, module or error more specifically.</div>` : ''}
      ${session?.retrievals ? `
        <div class="chart">
          <div class="legend" aria-hidden="true">
            <span><i class="key compare"></i>Without JevTrace</span>
            <span><i class="key"></i>Sent to the agent</span>
          </div>
          <div class="chart-body"></div>
        </div>` : ''}
      <div class="footnote">Estimated tokens (source characters ÷ 4). Totals reset when the MCP server restarts.</div>
    </section>`;
  renderChart(session);
  wireDetails();
}

function renderError(message: string): void {
  current = undefined;
  root.innerHTML = `
    <section class="card">
      <div class="eyebrow">JevTrace</div>
      <div class="error-title">Retrieval failed</div>
      <div class="error-body">${esc(message || 'The tool returned an error without a message.')}</div>
    </section>`;
}

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { if (current) renderChart(current.contextSavings?.session ?? current.session); });
}).observe(root);

app.ontoolinput = params => {
  const task = (params.arguments as { task?: unknown } | undefined)?.task;
  root.innerHTML = `<div class="loading">Retrieving context${typeof task === 'string' ? ` for “${esc(task)}”` : ''}…</div>`;
};

app.onhostcontextchanged = context => {
  if (context.theme) applyDocumentTheme(context.theme);
};

app.ontoolresult = result => {
  if (result.isError) {
    renderError(result.content?.map(part => part.type === 'text' ? part.text : '').join('\n').trim() ?? '');
    return;
  }
  render((result.structuredContent ?? {}) as ViewPayload);
};

app.connect().then(() => {
  const theme = app.getHostContext()?.theme;
  if (theme) applyDocumentTheme(theme);
}).catch(error => {
  root.innerHTML = `<div class="loading">Unable to connect JevTrace UI: ${esc(error instanceof Error ? error.message : String(error))}</div>`;
});
