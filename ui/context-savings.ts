import { App } from '@modelcontextprotocol/ext-apps';

interface Savings {
  estimated: true;
  basis: 'ranking-pool' | 'explicit-entry';
  available: boolean;
  candidateTokens?: number;
  returnedTokens: number;
  savedTokens?: number;
  reductionPercent?: number;
  tokenBudget: number;
  budgetUtilization: number;
  candidateSymbols?: number;
  returnedSymbols: number;
  omittedSymbols: number;
  rawNeighborhoodTokens?: number;
  cappedNeighborhoodTokens?: number;
  semanticLeads?: number;
  stage4Applied?: boolean;
  providerRequests: number;
  discoveryMs?: number;
  stage4Ms?: number;
  totalMs: number;
  latencyStats?: {
    medianMs: number;
    p95Ms: number;
    sampleCount: number;
    windowSize: number;
  };
  status: 'complete' | 'incomplete';
  warningCount: number;
}

interface ContextItem {
  node?: { name?: string; file?: string };
  kind?: string;
  score?: number;
}

interface ViewPayload {
  task?: string;
  items?: ContextItem[];
  contextSavings?: Savings;
}

const root = document.getElementById('app')!;
const app = new App({ name: 'JevTrace Context Savings', version: '0.1.0' });

const css = `
  :root {
    color-scheme: light dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --bg: #f7f7f5;
    --panel: rgba(255,255,255,.92);
    --panel-2: #f0f1ed;
    --text: #171915;
    --muted: #696e65;
    --line: rgba(23,25,21,.10);
    --accent: #2e6b4f;
    --accent-soft: #dff0e6;
    --bar-before: #a9ada5;
    --bar-after: #2e6b4f;
    --warn: #9b641c;
    --shadow: 0 12px 30px rgba(33, 38, 30, .08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111310;
      --panel: rgba(27,30,25,.96);
      --panel-2: #20241e;
      --text: #f0f2ed;
      --muted: #a7aea2;
      --line: rgba(255,255,255,.10);
      --accent: #7bc49b;
      --accent-soft: #183526;
      --bar-before: #646b61;
      --bar-after: #7bc49b;
      --warn: #e3ad5d;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent; color: var(--text); }
  #app { width: 100%; }
  .shell {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 18px;
    min-width: 280px;
  }
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
  .eyebrow { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 750; }
  h1 { font-size: 18px; line-height: 1.25; margin: 4px 0 0; font-weight: 760; }
  .task { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.45; max-width: 680px; }
  .badge {
    border: 1px solid var(--line); border-radius: 999px; padding: 5px 9px; font-size: 11px;
    white-space: nowrap; background: var(--panel);
  }
  .badge.complete { color: var(--accent); }
  .hero {
    display: grid; grid-template-columns: minmax(130px,.7fr) minmax(220px,1.3fr);
    gap: 14px; margin-bottom: 14px;
  }
  .hero-card, .chart-card, .metric, .pipeline, .context-list {
    background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow); border-radius: 14px;
  }
  .hero-card { padding: 18px; display: flex; flex-direction: column; justify-content: center; }
  .hero-number { color: var(--accent); font-weight: 800; font-size: clamp(34px, 9vw, 58px); letter-spacing: -.05em; line-height: .95; }
  .hero-number.neutral { color: var(--text); }
  .hero-label { font-size: 12px; margin-top: 8px; color: var(--muted); }
  .saved { font-size: 12px; margin-top: 5px; font-weight: 650; }
  .chart-card { padding: 16px; }
  .chart-title { display:flex; justify-content:space-between; gap: 8px; font-size: 12px; font-weight: 700; margin-bottom: 13px; }
  .estimate { color: var(--muted); font-weight: 500; }
  .bar-row { display: grid; grid-template-columns: 92px 1fr 74px; gap: 9px; align-items: center; font-size: 11px; margin: 9px 0; }
  .bar-label { color: var(--muted); }
  .bar-track { height: 9px; background: var(--panel-2); border-radius: 999px; overflow: hidden; }
  .bar { height: 100%; border-radius: inherit; min-width: 2px; }
  .bar.before { background: var(--bar-before); }
  .bar.after { background: var(--bar-after); }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px,1fr)); gap: 10px; margin-bottom: 14px; }
  .metric { padding: 12px; }
  .metric-name { color: var(--muted); font-size: 10px; margin-bottom: 5px; }
  .metric-value { font-size: 16px; font-weight: 760; font-variant-numeric: tabular-nums; }
  .metric-sub { color: var(--muted); font-size: 10px; margin-top: 3px; }
  .pipeline { padding: 14px; margin-bottom: 14px; }
  .pipeline-title { font-size: 11px; font-weight: 750; margin-bottom: 10px; }
  .steps { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; }
  .step { background: var(--panel-2); border-radius: 10px; padding: 9px; min-height: 58px; }
  .step-name { color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; }
  .step-value { font-size: 12px; font-weight: 700; margin-top: 5px; line-height: 1.2; }
  .context-list { padding: 14px; }
  .context-head { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:9px; }
  .context-title { font-size: 11px; font-weight:750; }
  .context-count { color:var(--muted); font-size:10px; }
  .item { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; padding:8px 0; border-top:1px solid var(--line); }
  .item:first-of-type { border-top:0; }
  .item-name { font-size:11px; font-weight:680; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item-file { color:var(--muted); font-size:9px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item-kind { color:var(--muted); font-size:9px; border:1px solid var(--line); border-radius:999px; padding:3px 6px; align-self:center; }
  .footnote { color: var(--muted); font-size: 9px; line-height: 1.45; margin-top: 10px; }
  .loading, .error { padding: 18px; font: 13px/1.5 ui-sans-serif,system-ui; color: var(--muted); }
  .error { color: #b74848; }
  @media (max-width: 620px) {
    .hero { grid-template-columns: 1fr; }
    .metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .steps { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .bar-row { grid-template-columns: 78px 1fr 64px; }
  }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const esc = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const integer = (value: number | undefined): string => value === undefined ? '—' : Math.round(value).toLocaleString();
const ms = (value: number | undefined): string => value === undefined ? '—' : `${Math.round(value)} ms`;
const pct = (value: number | undefined, digits = 1): string => value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`;

function render(payload: ViewPayload): void {
  const s = payload.contextSavings;
  if (!s) {
    root.innerHTML = '<div class="error">JevTrace returned no context-savings telemetry.</div>';
    return;
  }

  const candidate = s.candidateTokens ?? s.returnedTokens;
  const maxBar = Math.max(candidate, s.returnedTokens, 1);
  const beforeWidth = Math.max(2, candidate / maxBar * 100);
  const afterWidth = Math.max(2, s.returnedTokens / maxBar * 100);
  const hero = s.available ? pct(s.reductionPercent, 1) : integer(s.returnedTokens);
  const heroLabel = s.available ? 'estimated context reduction' : 'estimated returned tokens';
  const heroClass = s.available ? '' : ' neutral';
  const savedLine = s.available
    ? `${integer(s.savedTokens)} estimated tokens excluded`
    : 'Explicit-entry mode has no comparable final ranking pool';

  const items = (payload.items ?? []).slice(0, 6);
  const itemHtml = items.length
    ? items.map(item => `
      <div class="item">
        <div>
          <div class="item-name">${esc(item.node?.name ?? 'anonymous')}</div>
          <div class="item-file">${esc(item.node?.file ?? '')}</div>
        </div>
        <div class="item-kind">${esc(item.kind ?? 'lead')}</div>
      </div>`).join('')
    : '<div class="item"><div class="item-file">No returned symbols.</div></div>';

  root.innerHTML = `
    <section class="shell">
      <header class="header">
        <div>
          <div class="eyebrow">JevTrace · Context telemetry</div>
          <h1>Task-to-context retrieval</h1>
          <div class="task">${esc(payload.task ?? 'Task')}</div>
        </div>
        <div class="badge ${s.status === 'complete' ? 'complete' : ''}">${esc(s.status)}</div>
      </header>

      <div class="hero">
        <div class="hero-card">
          <div class="hero-number${heroClass}">${hero}</div>
          <div class="hero-label">${heroLabel}</div>
          <div class="saved">${savedLine}</div>
        </div>

        <div class="chart-card">
          <div class="chart-title">
            <span>Context passed to the coding agent</span>
            <span class="estimate">estimated tokens</span>
          </div>
          <div class="bar-row">
            <div class="bar-label">Candidate pool</div>
            <div class="bar-track"><div class="bar before" style="width:${beforeWidth}%"></div></div>
            <div class="bar-value">${integer(s.candidateTokens)}</div>
          </div>
          <div class="bar-row">
            <div class="bar-label">Returned</div>
            <div class="bar-track"><div class="bar after" style="width:${afterWidth}%"></div></div>
            <div class="bar-value">${integer(s.returnedTokens)}</div>
          </div>
        </div>
      </div>

      <div class="metrics">
        <div class="metric">
          <div class="metric-name">Budget use</div>
          <div class="metric-value">${pct(s.budgetUtilization, 0)}</div>
          <div class="metric-sub">${integer(s.returnedTokens)} / ${integer(s.tokenBudget)}</div>
        </div>
        <div class="metric">
          <div class="metric-name">Symbols</div>
          <div class="metric-value">${integer(s.returnedSymbols)}</div>
          <div class="metric-sub">${integer(s.candidateSymbols)} candidates</div>
        </div>
        <div class="metric">
          <div class="metric-name">Provider requests</div>
          <div class="metric-value">${integer(s.providerRequests)}</div>
          <div class="metric-sub">${s.stage4Applied ? 'includes Stage 4' : 'discovery path'}</div>
        </div>
        <div class="metric">
          <div class="metric-name">Current retrieval</div>
          <div class="metric-value">${ms(s.totalMs)}</div>
          <div class="metric-sub">${s.warningCount ? `${integer(s.warningCount)} warnings` : 'no warnings'}</div>
        </div>
        <div class="metric">
          <div class="metric-name">P95 latency</div>
          <div class="metric-value">${ms(s.latencyStats?.p95Ms)}</div>
          <div class="metric-sub">median ${ms(s.latencyStats?.medianMs)} · n ${integer(s.latencyStats?.sampleCount)}/${integer(s.latencyStats?.windowSize)}</div>
        </div>
      </div>

      <div class="pipeline">
        <div class="pipeline-title">Pipeline</div>
        <div class="steps">
          <div class="step">
            <div class="step-name">Semantic discovery</div>
            <div class="step-value">${integer(s.semanticLeads)} leads<br>${ms(s.discoveryMs)}</div>
          </div>
          <div class="step">
            <div class="step-name">Compiler graph</div>
            <div class="step-value">${integer(s.rawNeighborhoodTokens)} raw<br>${integer(s.cappedNeighborhoodTokens)} capped</div>
          </div>
          <div class="step">
            <div class="step-name">Stage 4</div>
            <div class="step-value">${s.stage4Applied ? 'Applied' : 'Skipped'}<br>${s.stage4Applied ? ms(s.stage4Ms) : 'pool fit budget'}</div>
          </div>
          <div class="step">
            <div class="step-name">Final context</div>
            <div class="step-value">${integer(s.returnedSymbols)} symbols<br>${integer(s.returnedTokens)} tokens</div>
          </div>
        </div>
      </div>

      <div class="context-list">
        <div class="context-head">
          <div class="context-title">Returned implementation context</div>
          <div class="context-count">showing ${items.length} of ${integer(s.returnedSymbols)}</div>
        </div>
        ${itemHtml}
      </div>

      <div class="footnote">
        Token counts are JevTrace estimates (approximately source characters ÷ 4), not provider billing tokens.
        “Reduction” compares the final ranking pool with the context returned by this MCP tool.
        Latency median/p95 use the latest server-lifetime rolling window (up to 50 task-only retrievals).
      </div>
    </section>
  `;
}

app.ontoolresult = result => {
  if (result.isError) {
    root.innerHTML = '<div class="error">JevTrace retrieval failed.</div>';
    return;
  }
  render((result.structuredContent ?? {}) as ViewPayload);
};

app.connect().catch(error => {
  root.innerHTML = `<div class="error">Unable to connect JevTrace UI: ${esc(error instanceof Error ? error.message : String(error))}</div>`;
});
