import { createRequire } from 'node:module';

/** The published package version: package.json sits next to `dist/` in the repository and in the npm package. */
export const version: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
