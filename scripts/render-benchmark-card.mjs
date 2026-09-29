// Renders the README benchmark card (light and dark SVG) from benchmarks/results/competitor/report.json,
// so every number in the image comes from the recorded head-to-head run rather than being typed by hand.
//   node scripts/render-benchmark-card.mjs [--report path] [--jg-tool jg-default]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const report = JSON.parse(fs.readFileSync(arg('--report') ?? path.join(projectRoot, 'benchmarks/results/competitor/report.json'), 'utf8'));
const jgTool = arg('--jg-tool') ?? 'jg-default';
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const summarize = tool => {
  const rows = report.rows.filter(row => row.tool === tool);
  if (!rows.length) throw new Error(`No rows for ${tool}`);
  return {
    cases: rows.length,
    recall: mean(rows.map(row => row.recall)),
    cost: mean(rows.map(row => row.jevCost)),
    seconds: mean(rows.map(row => row.ms)) / 1000,
    tokens: mean(rows.map(row => row.agentTokens)),
  };
};
const ours = summarize('jevtrace');
const theirs = summarize(jgTool);

// Reference-palette tokens (dataviz skill): accent slot 1 for JevTrace, the muted gray for the comparison.
const themes = {
  light: { bg: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', ours: '#2a78d6', theirs: '#b9b7b0', border: 'rgba(11,11,11,0.10)' },
  dark: { bg: '#1a1a19', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', ours: '#3987e5', theirs: '#5b5a55', border: 'rgba(255,255,255,0.10)' },
};

const panels = [
  { title: 'Required code delivered', note: 'higher is better', ours: ours.recall, theirs: theirs.recall,
    format: value => `${(value * 100).toFixed(1)}%`, max: 1, callout: `+${((ours.recall - theirs.recall) * 100).toFixed(1)} pts` },
  { title: 'Jev cost per search', note: 'lower is better', ours: ours.cost, theirs: theirs.cost,
    format: value => `$${value.toFixed(4)}`, callout: `${(theirs.cost / ours.cost).toFixed(1)}× cheaper` },
  { title: 'Search time', note: 'lower is better', ours: ours.seconds, theirs: theirs.seconds,
    format: value => `${value.toFixed(1)} s`, callout: `${(theirs.seconds / ours.seconds).toFixed(1)}× faster` },
  { title: 'Tokens handed to the agent', note: 'lower is better', ours: ours.tokens, theirs: theirs.tokens,
    format: value => Math.round(value).toLocaleString('en-US'), callout: `${Math.round((1 - ours.tokens / theirs.tokens) * 100)}% fewer` },
];

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function render(theme) {
  const t = themes[theme];
  const width = 960;
  const panelW = 440;
  const panelH = 132;
  const gapX = 24;
  const left = 28;
  const top = 96;
  const barX = 108;
  const barW = panelW - barX - 92;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${top + 2 * panelH + 24 + 58}" viewBox="0 0 ${width} ${top + 2 * panelH + 24 + 58}" role="img" aria-label="JevTrace versus jevgrep on ${ours.cases} JS/TS tasks: ${panels.map(panel => `${panel.title} ${panel.format(panel.ours)} versus ${panel.format(panel.theirs)}`).join('; ')}">`);
  parts.push(`<style>text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>`);
  parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${top + 2 * panelH + 24 + 57}" rx="16" fill="${t.bg}" stroke="${t.border}"/>`);
  parts.push(`<text x="${left}" y="44" font-size="24" font-weight="700" fill="${t.ink}">JevTrace vs jevgrep</text>`);
  parts.push(`<text x="${left}" y="70" font-size="14" fill="${t.ink2}">Same ${ours.cases} JS/TS tasks, same checkouts, same scoring, same Jev provider</text>`);
  // Legend (identity never by color alone: bars are also labelled per row).
  const legendX = width - 250;
  parts.push(`<rect x="${legendX}" y="34" width="14" height="10" rx="2" fill="${t.ours}"/><text x="${legendX + 20}" y="44" font-size="13" fill="${t.ink2}">JevTrace</text>`);
  parts.push(`<rect x="${legendX + 100}" y="34" width="14" height="10" rx="2" fill="${t.theirs}"/><text x="${legendX + 120}" y="44" font-size="13" fill="${t.ink2}">jevgrep 0.7.0</text>`);

  panels.forEach((panel, index) => {
    const x = left + (index % 2) * (panelW + gapX);
    const y = top + Math.floor(index / 2) * panelH;
    const max = panel.max ?? Math.max(panel.ours, panel.theirs) * 1.05;
    parts.push(`<line x1="${x}" x2="${x + panelW}" y1="${y}" y2="${y}" stroke="${t.grid}"/>`);
    parts.push(`<text x="${x}" y="${y + 26}" font-size="15" font-weight="650" fill="${t.ink}">${esc(panel.title)}</text>`);
    parts.push(`<text x="${x + panelW}" y="${y + 26}" font-size="15" font-weight="700" fill="${t.ours}" text-anchor="end">${esc(panel.callout)}</text>`);
    parts.push(`<text x="${x}" y="${y + 44}" font-size="11" fill="${t.muted}">${esc(panel.note)}</text>`);
    [['JevTrace', panel.ours, t.ours, 62], ['jevgrep', panel.theirs, t.theirs, 94]].forEach(([label, value, color, dy]) => {
      const w = Math.max(3, value / max * barW);
      parts.push(`<text x="${x}" y="${y + dy + 13}" font-size="13" fill="${t.ink2}">${label}</text>`);
      parts.push(`<rect x="${x + barX}" y="${y + dy}" width="${w.toFixed(1)}" height="18" rx="4" fill="${color}"/>`);
      parts.push(`<text x="${x + barX + w + 8}" y="${y + dy + 13}" font-size="13" font-weight="650" fill="${t.ink}">${esc(panel.format(value))}</text>`);
    });
  });
  const footY = top + 2 * panelH + 30;
  parts.push(`<text x="${left}" y="${footY}" font-size="11.5" fill="${t.muted}">Retrieval benchmark, one cold search per task. Task labels were written by the JevTrace authors; "delivered" counts source in the tool output,</text>`);
  parts.push(`<text x="${left}" y="${footY + 17}" font-size="11.5" fill="${t.muted}">not files listed as reading leads. Tokens are characters ÷ 4. Method, per-task results and reproduction: docs/benchmark-vs-jevgrep.md</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
for (const theme of Object.keys(themes)) {
  fs.writeFileSync(path.join(projectRoot, 'assets', `benchmark-vs-jevgrep-${theme}.svg`), render(theme) + '\n');
}
console.log(`JevTrace ${JSON.stringify(ours)}\njevgrep ${JSON.stringify(theirs)}`);
