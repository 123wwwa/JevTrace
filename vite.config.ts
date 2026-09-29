import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.join(projectRoot, 'ui');

export default defineConfig({
  root: uiRoot,
  plugins: [viteSingleFile()],
  build: {
    outDir: path.join(projectRoot, 'dist'),
    emptyOutDir: false,
    minify: true,
    rollupOptions: {
      input: path.join(uiRoot, 'context-savings.html'),
    },
  },
});
