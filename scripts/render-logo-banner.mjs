// Renders the README logo banner (light and dark SVG) with the same palette as the benchmark card
// and the same typefaces as the intro video (Inter for text, JetBrains Mono for code terms).
//   node scripts/render-logo-banner.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same tokens as scripts/render-benchmark-card.mjs, plus a card fill for the node boxes.
const themes = {
  light: { bg: '#fcfcfb', card: '#ffffff', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', accent: '#2a78d6', gray: '#b9b7b0', border: 'rgba(11,11,11,0.10)', onAccent: '#ffffff' },
  dark: { bg: '#1a1a19', card: '#232322', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', accent: '#3987e5', gray: '#5b5a55', border: 'rgba(255,255,255,0.10)', onAccent: '#ffffff' },
};
const sans = `Inter,system-ui,-apple-system,"Segoe UI",sans-serif`;
const mono = `"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

const width = 960;
const height = 300;
const hub = { x: 700, y: 150, r: 40 };
const rows = [90, 150, 210];
const cardH = 46;
const inX = 462;
const inW = 142;
const outX = 800;
const outW = 128;

// 24px line icons, drawn at (x, y) = top-left.
const icons = {
  ts: (t, x, y) => `<rect x="${x}" y="${y}" width="24" height="24" rx="5" fill="${t.accent}"/><text x="${x + 12}" y="${y + 17}" class="mono" font-size="12" font-weight="700" fill="${t.onAccent}" text-anchor="middle">TS</text>`,
  js: (t, x, y) => `<rect x="${x}" y="${y}" width="24" height="24" rx="5" fill="${t.gray}"/><text x="${x + 12}" y="${y + 17}" class="mono" font-size="12" font-weight="700" fill="${t.ink}" text-anchor="middle">JS</text>`,
  deps: (t, x, y) => `<g fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M${x + 7} ${y + 6}l-6 6 6 6M${x + 17} ${y + 6}l6 6-6 6M${x + 14} ${y + 3}l-4 18"/></g>`,
  context: (t, x, y) => `<g fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="${x + 4}" y="${y + 2}" width="16" height="20" rx="3"/><path d="M${x + 8} ${y + 8}h8M${x + 8} ${y + 12}h8M${x + 8} ${y + 16}h5"/></g>`,
  symbols: (t, x, y) => `<g fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round"><path d="M${x + 10.5} ${y + 8.5}l-5 8M${x + 13.5} ${y + 8.5}l5 8"/><circle cx="${x + 12}" cy="${y + 5}" r="3"/><circle cx="${x + 4.5}" cy="${y + 19}" r="3"/><circle cx="${x + 19.5}" cy="${y + 19}" r="3"/></g>`,
  agent: (t, x, y) => `<g fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="${x + 3}" y="${y + 7}" width="18" height="14" rx="4"/><path d="M${x + 12} ${y + 7}V${y + 3}M${x + 1} ${y + 13}v3M${x + 23} ${y + 13}v3"/><circle cx="${x + 12}" cy="${y + 2.5}" r="1.2" fill="${t.accent}"/></g><circle cx="${x + 9}" cy="${y + 13}" r="1.5" fill="${t.accent}"/><circle cx="${x + 15}" cy="${y + 13}" r="1.5" fill="${t.accent}"/>`,
};
const inputs = [['ts', 'AST'], ['js', 'types'], ['deps', 'deps']];
const outputs = [['context', 'context'], ['symbols', 'symbols'], ['agent', 'agent']];

function card(t, x, w, y, icon, label) {
  const top = y - cardH / 2;
  return [
    `<rect x="${x}" y="${top}" width="${w}" height="${cardH}" rx="10" fill="${t.card}" stroke="${t.border}"/>`,
    icons[icon](t, x + 14, y - 12),
    `<text x="${x + 50}" y="${y + 6}" class="mono" font-size="17" font-weight="700" fill="${t.ink}">${label}</text>`,
  ].join('');
}

function render(theme) {
  const t = themes[theme];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="JevTrace — compiler-guided context for TypeScript/JavaScript: AST, types and deps in; context, symbols and agent-ready code out">`);
  parts.push(`<style>text{font-family:${sans}}.mono{font-family:${mono}}</style>`);
  parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" fill="${t.bg}" stroke="${t.border}"/>`);

  // Wordmark and tagline.
  parts.push(`<text x="44" y="152" font-size="78" font-weight="800" letter-spacing="-2" fill="${t.ink}">JevTrace</text>`);
  parts.push(`<text x="46" y="194" font-size="21" font-weight="600" fill="${t.ink2}">Compiler-guided context</text>`);
  parts.push(`<text x="46" y="222" font-size="21" font-weight="600" fill="${t.ink2}">for <tspan fill="${t.accent}">TypeScript/JavaScript</tspan>.</text>`);

  // Connectors run into the hub centre and are covered by it; inputs gray, outputs accent (as in the card legend).
  for (const y of rows) {
    const x0 = inX + inW;
    parts.push(`<path d="M${x0} ${y}C${x0 + 44} ${y} ${hub.x - 60} ${hub.y} ${hub.x} ${hub.y}" fill="none" stroke="${t.gray}" stroke-width="2"/>`);
    parts.push(`<circle cx="${x0}" cy="${y}" r="4" fill="${t.gray}"/>`);
    parts.push(`<path d="M${hub.x} ${hub.y}C${hub.x + 60} ${hub.y} ${outX - 44} ${y} ${outX} ${y}" fill="none" stroke="${t.accent}" stroke-width="2"/>`);
    parts.push(`<circle cx="${outX}" cy="${y}" r="4" fill="${t.accent}"/>`);
  }

  // Hub: accent disc with a soft halo and a "code file + search" glyph.
  parts.push(`<circle cx="${hub.x}" cy="${hub.y}" r="${hub.r + 12}" fill="${t.accent}" opacity="0.16"/>`);
  parts.push(`<circle cx="${hub.x}" cy="${hub.y}" r="${hub.r}" fill="${t.accent}"/>`);
  const gx = hub.x - 14;
  const gy = hub.y - 18;
  parts.push(`<g fill="none" stroke="${t.onAccent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M${gx + 14} ${gy + 34}H${gx + 3}a3 3 0 0 1-3-3V${gy + 3}a3 3 0 0 1 3-3h13l8 8v8"/><path d="M${gx + 8} ${gy + 13}l-3 4 3 4M${gx + 16} ${gy + 13}l3 4-3 4"/><circle cx="${gx + 23}" cy="${gy + 26}" r="5"/><path d="M${gx + 27} ${gy + 30}l4 4"/></g>`);

  inputs.forEach(([icon, label], i) => parts.push(card(t, inX, inW, rows[i], icon, label)));
  outputs.forEach(([icon, label], i) => parts.push(card(t, outX, outW, rows[i], icon, label)));
  parts.push('</svg>');
  return parts.join('\n');
}

fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
for (const theme of Object.keys(themes)) {
  fs.writeFileSync(path.join(projectRoot, 'assets', `logo-banner-${theme}.svg`), render(theme) + '\n');
}
