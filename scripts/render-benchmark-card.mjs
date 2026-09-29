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

// One big number per metric and a pair of bars; everything else lives in the linked document.
const panels = [
  { title: 'Required code found', headline: `${(ours.recall * 100).toFixed(1)}%`, sub: `vs ${(theirs.recall * 100).toFixed(1)}%`, ours: ours.recall, theirs: theirs.recall, max: 1 },
  { title: 'Jev cost', headline: `${(theirs.cost / ours.cost).toFixed(1)}×`, sub: 'cheaper', ours: ours.cost, theirs: theirs.cost },
  { title: 'Search speed', headline: `${(theirs.seconds / ours.seconds).toFixed(1)}×`, sub: 'faster', ours: ours.seconds, theirs: theirs.seconds },
  { title: 'Agent tokens', headline: `${Math.round((1 - ours.tokens / theirs.tokens) * 100)}%`, sub: 'fewer', ours: ours.tokens, theirs: theirs.tokens },
];

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function render(theme) {
  const t = themes[theme];
  const width = 960;
  const height = 400;
  const left = 32;
  const colW = (width - left * 2) / panels.length;
  const barTop = 232;
  const barH = 118;
  const barW = 44;
  const label = `JevTrace vs jevgrep on ${ours.cases} JS/TS tasks: ${panels.map(panel => `${panel.title} ${panel.headline} ${panel.sub}`).join('; ')}`;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">`);
  parts.push(`<style>text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>`);
  parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" fill="${t.bg}" stroke="${t.border}"/>`);
  parts.push(`<text x="${left}" y="58" font-size="34" font-weight="750" fill="${t.ink}">JevTrace <tspan fill="${t.muted}" font-weight="500">vs</tspan> jevgrep</text>`);
  const legendX = width - left - 290;
  parts.push(`<rect x="${legendX}" y="36" width="18" height="18" rx="4" fill="${t.ours}"/><text x="${legendX + 26}" y="52" font-size="20" fill="${t.ink2}">JevTrace</text>`);
  parts.push(`<rect x="${legendX + 140}" y="36" width="18" height="18" rx="4" fill="${t.theirs}"/><text x="${legendX + 166}" y="52" font-size="20" fill="${t.ink2}">jevgrep</text>`);

  panels.forEach((panel, index) => {
    const cx = left + colW * index + colW / 2;
    if (index) parts.push(`<line x1="${left + colW * index}" x2="${left + colW * index}" y1="100" y2="${height - 28}" stroke="${t.grid}"/>`);
    parts.push(`<text x="${cx}" y="116" font-size="20" font-weight="600" fill="${t.ink2}" text-anchor="middle">${esc(panel.title)}</text>`);
    parts.push(`<text x="${cx}" y="174" font-size="56" font-weight="800" fill="${t.ours}" text-anchor="middle">${esc(panel.headline)}</text>`);
    parts.push(`<text x="${cx}" y="206" font-size="20" font-weight="600" fill="${t.ink2}" text-anchor="middle">${esc(panel.sub)}</text>`);
    const max = panel.max ?? Math.max(panel.ours, panel.theirs);
    [[panel.ours, t.ours, -1], [panel.theirs, t.theirs, 1]].forEach(([value, color, side]) => {
      const h = Math.max(4, value / max * barH);
      const x = cx + side * 8 + (side < 0 ? -barW : 0);
      parts.push(`<rect x="${x}" y="${barTop + barH - h}" width="${barW}" height="${h}" rx="5" fill="${color}"/>`);
    });
    parts.push(`<line x1="${cx - 70}" x2="${cx + 70}" y1="${barTop + barH}" y2="${barTop + barH}" stroke="${t.grid}" stroke-width="2"/>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}

fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
for (const theme of Object.keys(themes)) {
  fs.writeFileSync(path.join(projectRoot, 'assets', `benchmark-vs-jevgrep-${theme}.svg`), render(theme) + '\n');
}
console.log(`JevTrace ${JSON.stringify(ours)}\njevgrep ${JSON.stringify(theirs)}`);
