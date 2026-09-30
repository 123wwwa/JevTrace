import { createRequire } from 'node:module';
import ts from 'typescript';

/**
 * Vue single-file components. The script blocks are kept in place and everything else (template, style,
 * custom blocks, the tags themselves) is blanked to spaces with newlines kept, so the TypeScript compiler reads
 * the `.vue` file as a script whose positions and line numbers are the file's own: no source map is needed to
 * report a declaration or call site. Template expressions are not analysed.
 */

export const isVueFile = (file: string): boolean => /\.vue$/i.test(file);

export interface VueScript {
  /** The file text with only the script blocks left. */
  text: string;
  kind: ts.ScriptKind;
  /** Range of the `<script setup>` content: top-level code there runs as the component's setup. */
  setup?: { start: number; end: number };
}

type SfcBlock = { content: string; lang?: string; loc: { start: { offset: number }; end: { offset: number } } };
type SfcParse = (source: string, options?: { filename?: string }) => { descriptor: { script: SfcBlock | null; scriptSetup: SfcBlock | null } };
let sfcParse: SfcParse | undefined;
/** Loaded on the first `.vue` file, so repositories without Vue never pay for the parser. */
const parser = (): SfcParse => {
  sfcParse ??= (createRequire(import.meta.url)('@vue/compiler-sfc') as { parse: SfcParse }).parse;
  return sfcParse;
};

const blank = (text: string): string => text.replace(/[^\r\n]/g, ' ');
const kindOf = (lang: string | undefined): ts.ScriptKind =>
  lang === 'tsx' ? ts.ScriptKind.TSX : lang === 'ts' ? ts.ScriptKind.TS : lang === 'jsx' ? ts.ScriptKind.JSX : ts.ScriptKind.JS;

const cache = new Map<string, VueScript>();

export function vueScript(text: string, fileName = 'component.vue'): VueScript {
  const cached = cache.get(text);
  if (cached) return cached;
  const { script, scriptSetup } = parser()(text, { filename: fileName }).descriptor;
  const blocks = [script, scriptSetup].filter((block): block is SfcBlock => block !== null)
    .sort((a, b) => a.loc.start.offset - b.loc.start.offset);
  let result = '';
  let cursor = 0;
  for (const block of blocks) {
    result += blank(text.slice(cursor, block.loc.start.offset)) + text.slice(block.loc.start.offset, block.loc.end.offset);
    cursor = block.loc.end.offset;
  }
  result += blank(text.slice(cursor));
  // Mixed blocks (`<script lang="ts">` next to `<script setup>`) are read with the most capable kind.
  const kinds = blocks.map(block => kindOf(block.lang));
  const kind = kinds.includes(ts.ScriptKind.TSX) ? ts.ScriptKind.TSX : kinds.includes(ts.ScriptKind.TS) ? ts.ScriptKind.TS
    : kinds.includes(ts.ScriptKind.JSX) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const vue: VueScript = { text: result, kind, ...(scriptSetup ? { setup: { start: scriptSetup.loc.start.offset, end: scriptSetup.loc.end.offset } } : {}) };
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(text, vue);
  return vue;
}

/** Reads a source file as the compiler should see it: `.vue` files through `vueScript`, others unchanged. */
export function scriptText(fileName: string, text: string): string {
  return isVueFile(fileName) ? vueScript(text, fileName).text : text;
}
