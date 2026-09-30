// Renders the README logo banner (light and dark SVG) with the same palette as the benchmark card
// and the same typefaces as the intro video (Inter for text, JetBrains Mono for code terms).
// The diagram walks through one query: a task goes in, the compiler traces the code it touches
// while Jev drops what is irrelevant, and the kept code comes back within the token budget.
//   node scripts/render-logo-banner.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same tokens as scripts/render-benchmark-card.mjs, plus a card fill for the boxes.
const themes = {
  light: { bg: '#fcfcfb', card: '#ffffff', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', accent: '#2a78d6', gray: '#b9b7b0', border: 'rgba(11,11,11,0.10)', onAccent: '#ffffff' },
  dark: { bg: '#1a1a19', card: '#232322', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', accent: '#3987e5', gray: '#5b5a55', border: 'rgba(255,255,255,0.10)', onAccent: '#ffffff' },
};
const sans = `Inter,system-ui,-apple-system,"Segoe UI",sans-serif`;
const mono = `"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

const width = 960;
const height = 300;
const midY = 160;
// Three steps, left to right: [x, width].
const task = [392, 118];
const trace = [548, 242];
const context = [826, 104];
const box = { top: 96, h: 128 };

// Code graph for step 2. rel = how the compiler reached it; drop = judged irrelevant by Jev.
const hub = { x: 662, name: 'verify()' };
const nodes = [
  { x: 590, y: 104, name: 'refresh()', rel: 'caller' },
  { x: 750, y: 104, name: 'Token', rel: 'type' },
  { x: 590, y: 216, name: 'auth.test', rel: 'test' },
  { x: 750, y: 216, name: 'sign()', rel: 'calls' },
  { x: 752, y: midY, name: 'log()', drop: true },
];
const pillW = name => name.length * 7.4 + 18;

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function step(t, x, n, title) {
  return `<circle cx="${x + 9}" cy="62" r="9" fill="${t.accent}"/><text x="${x + 9}" y="66.5" font-size="12" font-weight="800" fill="${t.onAccent}" text-anchor="middle">${n}</text>`
    + `<text x="${x + 24}" y="67" font-size="15" font-weight="700" fill="${t.ink}">${title}</text>`;
}
const caption = (t, x, text) => `<text x="${x}" y="270" font-size="13" font-weight="500" fill="${t.muted}">${esc(text)}</text>`;
const arrow = (t, x0, x1) => `<path d="M${x0} ${midY}H${x1 - 2}" stroke="${t.gray}" stroke-width="2"/><path d="M${x1 - 7} ${midY - 5}l6 5-6 5" fill="none" stroke="${t.gray}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

function render(theme) {
  const t = themes[theme];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="JevTrace — compiler-guided context for TypeScript/JavaScript. 1. Task: describe the change in plain language. 2. Trace: the TypeScript compiler follows callers, types, calls and tests while Jev drops irrelevant code. 3. Context: the kept code is returned within the token budget.">`);
  parts.push(`<style>text{font-family:${sans}}.mono{font-family:${mono}}</style>`);
  parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" fill="${t.bg}" stroke="${t.border}"/>`);

  // Wordmark and tagline.
  parts.push(`<text x="42" y="150" font-size="70" font-weight="800" letter-spacing="-2" fill="${t.ink}">JevTrace</text>`);
  parts.push(`<text x="44" y="188" font-size="19" font-weight="600" fill="${t.ink2}">Compiler-guided context</text>`);
  parts.push(`<text x="44" y="214" font-size="19" font-weight="600" fill="${t.ink2}">for <tspan fill="${t.accent}">TypeScript/JavaScript</tspan>.</text>`);

  // 1. Task — the input is a sentence, not a file path.
  const [tx, tw] = task;
  parts.push(step(t, tx, 1, 'Task'));
  parts.push(`<rect x="${tx}" y="${box.top}" width="${tw}" height="${box.h}" rx="10" fill="${t.card}" stroke="${t.border}"/>`);
  parts.push(`<text x="${tx + 14}" y="${box.top + 24}" font-size="10" font-weight="800" letter-spacing="1.5" fill="${t.accent}">TASK</text>`);
  ['“Fix refresh', 'token', 'validation”'].forEach((line, i) => {
    parts.push(`<text class="mono" x="${tx + 14}" y="${box.top + 54 + i * 20}" font-size="14" font-weight="700" fill="${t.ink}">${esc(line)}</text>`);
  });
  parts.push(caption(t, tx, 'plain language'));
  parts.push(arrow(t, tx + tw + 4, trace[0]));

  // 2. Trace — edges first so the pills sit on top of them.
  const [gx] = trace;
  parts.push(step(t, gx, 2, 'Trace'));
  for (const node of nodes) {
    parts.push(node.drop
      ? `<path d="M${hub.x} ${midY}L${node.x} ${node.y}" stroke="${t.gray}" stroke-width="1.5" stroke-dasharray="3 4"/>`
      : `<path d="M${hub.x} ${midY}L${node.x} ${node.y}" stroke="${t.accent}" stroke-width="1.5"/>`);
  }
  const hubW = pillW(hub.name) + 8;
  parts.push(`<rect x="${hub.x - hubW / 2}" y="${midY - 16}" width="${hubW}" height="32" rx="16" fill="${t.accent}"/>`);
  parts.push(`<text class="mono" x="${hub.x}" y="${midY + 5}" font-size="13" font-weight="700" fill="${t.onAccent}" text-anchor="middle">${hub.name}</text>`);
  for (const node of nodes) {
    const w = pillW(node.name);
    const fill = node.drop ? t.bg : t.card;
    const stroke = node.drop ? t.gray : t.accent;
    const dash = node.drop ? ' stroke-dasharray="3 3"' : '';
    parts.push(`<rect x="${node.x - w / 2}" y="${node.y - 13}" width="${w}" height="26" rx="13" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash}/>`);
    parts.push(`<text class="mono" x="${node.x}" y="${node.y + 4.5}" font-size="12" font-weight="700" fill="${node.drop ? t.muted : t.ink}" text-anchor="middle"${node.drop ? ' text-decoration="line-through"' : ''}>${node.name}</text>`);
    if (node.rel) {
      const above = node.y < midY;
      parts.push(`<text x="${node.x}" y="${above ? node.y - 19 : node.y + 28}" font-size="11" font-weight="600" fill="${t.muted}" text-anchor="middle">${node.rel}</text>`);
    }
  }
  parts.push(caption(t, gx, 'compiler follows links · Jev drops noise'));
  parts.push(arrow(t, trace[0] + trace[1], context[0]));

  // 3. Context — kept symbols with their bodies, and how much of the budget they use.
  const [cx, cw] = context;
  parts.push(step(t, cx, 3, 'Context'));
  parts.push(`<rect x="${cx}" y="${box.top}" width="${cw}" height="${box.h}" rx="10" fill="${t.card}" stroke="${t.border}"/>`);
  [0, 1, 2].forEach(i => {
    const y = box.top + 16 + i * 26;
    parts.push(`<rect x="${cx + 12}" y="${y}" width="${[46, 34, 52][i]}" height="6" rx="3" fill="${t.accent}"/>`);
    parts.push(`<rect x="${cx + 20}" y="${y + 11}" width="${[64, 56, 44][i]}" height="5" rx="2.5" fill="${t.gray}"/>`);
  });
  const budgetY = box.top + box.h - 30;
  parts.push(`<rect x="${cx + 12}" y="${budgetY}" width="${cw - 24}" height="6" rx="3" fill="${t.grid}"/>`);
  parts.push(`<rect x="${cx + 12}" y="${budgetY}" width="${(cw - 24) * 0.42}" height="6" rx="3" fill="${t.accent}"/>`);
  parts.push(`<text class="mono" x="${cx + 12}" y="${budgetY + 20}" font-size="10.5" font-weight="700" fill="${t.ink2}">3.4k / 8k tok</text>`);
  parts.push(caption(t, cx, 'within budget'));

  parts.push('</svg>');
  return parts.join('\n');
}

fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
for (const theme of Object.keys(themes)) {
  fs.writeFileSync(path.join(projectRoot, 'assets', `logo-banner-${theme}.svg`), render(theme) + '\n');
}
