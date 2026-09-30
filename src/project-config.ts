import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Vue components are project sources too, as in vue-tsc: an include pattern such as "src/**/*" lists them.
const extraFileExtensions: ts.FileExtensionInfo[] = [{ extension: '.vue', isMixedContent: false, scriptKind: ts.ScriptKind.Deferred }];

const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

export interface ParsedProjectConfig {
  path: string;
  files: Set<string>;
  parsed: ts.ParsedCommandLine;
}

export function discoverProjectConfigs(root: string): string[] {
  const resolvedRoot = path.resolve(root);
  const configs: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
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

  for (const configPath of discoverProjectConfigs(root)) {
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
      files: new Set(parsed.fileNames.map(fileName => path.resolve(fileName))),
    });
  }

  if (withoutBase.length) {
    const shown = withoutBase.slice(0, 4).join(', ');
    warnings.push(`${withoutBase.length} project${withoutBase.length === 1 ? '' : 's'} analysed without their base config, which was not found (${shown}${withoutBase.length > 4 ? `, +${withoutBase.length - 4} more` : ''}); install dependencies for exact compiler options`);
  }
  return { projects, warnings };
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
