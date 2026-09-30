// Assembles the GitHub Pages site: page/index.html with the benchmark numbers filled in from the same data the
// video renders, plus the rendered out/jevtrace.mp4 and out/poster.png.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const videoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(videoRoot, 'site');
const read = file => JSON.parse(fs.readFileSync(path.join(videoRoot, 'src', 'data', file), 'utf8'));
const metrics = read('metrics.json');
const demo = read('demo.json');
const values = {
  ...metrics,
  reduction: Math.round((1 - metrics.agentTokensWith / metrics.agentTokensWithout) * 100),
  recallRounded: Math.round(metrics.recall),
  repository: demo.repository,
  capturedAt: demo.capturedAt,
};

fs.rmSync(site, { recursive: true, force: true });
fs.mkdirSync(site, { recursive: true });
const html = fs.readFileSync(path.join(videoRoot, 'page', 'index.html'), 'utf8')
  .replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`No value for ${match}`);
    return String(values[key]);
  });
fs.writeFileSync(path.join(site, 'index.html'), html);
for (const file of ['jevtrace.mp4', 'poster.png']) {
  const source = path.join(videoRoot, 'out', file);
  if (!fs.existsSync(source)) throw new Error(`Render ${file} first (npm run render / npm run still)`);
  fs.copyFileSync(source, path.join(site, file));
}
// GitHub Pages would otherwise run the site through Jekyll.
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`site/ ready: ${fs.readdirSync(site).join(', ')}`);
