import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describeSkipped, readDirectory } from './fs-walk.js';

// Vue components are project sources too, as in vue-tsc: an include pattern such as "src/**/*" lists them.
const extraFileExtensions: ts.FileExtensionInfo[] = [{ extension: '.vue', isMixedContent: false, scriptKind: ts.ScriptKind.Deferred }];

const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

export interface ParsedProjectConfig {
  path: string;
  files: Set<string>;
  parsed: ts.ParsedCommandLine;
}

export function discoverProjectConfigs(root: string, skipped?: string[]): string[] {
  const resolvedRoot = path.resolve(root);
  const configs: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readDirectory(directory, skipped)) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith('.')) walk(full);
        continue;
      }
      if (entry.isFile() && /^[jt]sconfig(?:\.[^.]+)*\.json$/i.test(entry.name)) configs.push(full);
    }
  };

  walk(resolvedRoot);
  return configs.sort((a, b) => a.localeCompare(b));
}

export function parseProjectConfigs(root: string): { projects: ParsedProjectConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const projects: ParsedProjectConfig[] = [];
  const withoutBase: string[] = [];
  const skipped: string[] = [];
  const configPaths = discoverProjectConfigs(root, skipped);
  const skippedNote = describeSkipped(path.resolve(root), skipped);
  if (skippedNote) warnings.push(skippedNote);

  for (const configPath of configPaths) {
    // TypeScript's config APIs expect '/'-separated paths; a Windows path makes it assert on a parse error.
    const tsPath = configPath.replaceAll('\\', '/');
    let parsed: ts.ParsedCommandLine;
    try {
      const raw = ts.readConfigFile(tsPath, ts.sys.readFile);
      if (raw.error) {
        warnings.push(`Skipped project ${path.relative(root, configPath)}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
        continue;
      }
      // jsconfig.json implies JavaScript sources, with the defaults the TypeScript language service gives it.
      const jsDefaults = /^jsconfig/i.test(path.basename(tsPath))
        ? { allowJs: true, maxNodeModuleJsDepth: 2, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true }
        : undefined;
      parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(tsPath), jsDefaults, tsPath, undefined, extraFileExtensions);
      // A base config from a workspace package (`"extends": "@org/tsconfig/node.json"`) is missing until
      // dependencies are installed. Its own include list still says which files belong to the project.
      if (parsed.errors.length && raw.config?.extends !== undefined) {
        const { extends: _base, ...own } = raw.config as Record<string, unknown>;
        const retried = ts.parseJsonConfigFileContent(own, ts.sys, path.dirname(tsPath), jsDefaults, tsPath, undefined, extraFileExtensions);
        if (!retried.errors.length) {
          withoutBase.push(path.relative(root, configPath).replaceAll('\\', '/'));
          parsed = retried;
        }
      }
    } catch (error) {
      // One unreadable config must not take down every other project.
      warnings.push(`Skipped project ${path.relative(root, configPath)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (parsed.errors.length) {
      warnings.push(`Skipped project ${path.relative(root, configPath)}: ${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, ' ')}`);
      continue;
    }

    projects.push({
      path: configPath,
      parsed,
      files: importClosure(parsed, tsPath),
    });
  }

  if (withoutBase.length) {
    const shown = withoutBase.slice(0, 4).join(', ');
    warnings.push(`${withoutBase.length} project${withoutBase.length === 1 ? '' : 's'} analysed without their base config, which was not found (${shown}${withoutBase.length > 4 ? `, +${withoutBase.length - 4} more` : ''}); install dependencies for exact compiler options`);
  }
  return { projects, warnings };
}

const importCache = new Map<string, { version: string; imports: string[] }>();

function importsOf(file: string): string[] {
  let version: string;
  try {
    const stat = fs.statSync(file, { bigint: true });
    version = `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return [];
  }
  const cached = importCache.get(file);
  if (cached?.version === version) return cached.imports;
  const info = ts.preProcessFile(ts.sys.readFile(file) ?? '', true, true);
  const imports = info.importedFiles.map(reference => reference.fileName);
  importCache.set(file, { version, imports });
  return imports;
}

const javaScriptExtensions = new Set<string>([ts.Extension.Js, ts.Extension.Jsx, ts.Extension.Mjs, ts.Extension.Cjs]);
const typeScriptExtensions = new Set<string>([ts.Extension.Ts, ts.Extension.Tsx, ts.Extension.Mts, ts.Extension.Cts]);

/**
 * The files a config includes plus the project sources they import, as the compiler loads them: a config
 * that lists only its entry points (`"include": ["src/index.ts"]`) still owns the modules behind them.
 * Declaration files, dependencies and, without allowJs, JavaScript files stay out, as in the program.
 */
function importClosure(parsed: ts.ParsedCommandLine, configPath: string): Set<string> {
  const files = new Set(parsed.fileNames.map(fileName => path.resolve(fileName)));
  const cache = ts.createModuleResolutionCache(path.dirname(configPath), name => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(), parsed.options);
  // Vue components are read through their script blocks elsewhere; their imports are not followed here.
  const queue = [...files].filter(file => !/\.vue$/i.test(file));
  while (queue.length) {
    const importer = queue.pop()!;
    for (const specifier of importsOf(importer)) {
      const resolved = ts.resolveModuleName(specifier, importer.replaceAll('\\', '/'), parsed.options, ts.sys, cache).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      const allowed = typeScriptExtensions.has(resolved.extension) || (parsed.options.allowJs && javaScriptExtensions.has(resolved.extension));
      const file = path.resolve(resolved.resolvedFileName);
      if (!allowed || files.has(file) || file.split(path.sep).includes('node_modules')) continue;
      files.add(file);
      queue.push(file);
    }
  }
  return files;
}

export function selectProjectFromParsed(projects: ParsedProjectConfig[], file: string): ParsedProjectConfig | undefined {
  const absolute = path.resolve(file);
  const matches = projects.filter(project => project.files.has(absolute));
  if (!matches.length) return undefined;

  matches.sort((a, b) => {
    const aDir = path.dirname(a.path);
    const bDir = path.dirname(b.path);
    const aRelative = path.relative(aDir, absolute);
    const bRelative = path.relative(bDir, absolute);
    const aDepth = aRelative.split(path.sep).length;
    const bDepth = bRelative.split(path.sep).length;
    return aDepth - bDepth || bDir.length - aDir.length || a.path.localeCompare(b.path);
  });

  return matches[0];
}

export function selectProjectConfig(root: string, file: string): ParsedProjectConfig | undefined {
  return selectProjectFromParsed(parseProjectConfigs(root).projects, file);
}
