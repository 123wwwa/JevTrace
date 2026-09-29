import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
      if (entry.isFile() && /^tsconfig(?:\.[^.]+)*\.json$/i.test(entry.name)) configs.push(full);
    }
  };

  walk(resolvedRoot);
  return configs.sort((a, b) => a.localeCompare(b));
}

export function parseProjectConfigs(root: string): { projects: ParsedProjectConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const projects: ParsedProjectConfig[] = [];

  for (const configPath of discoverProjectConfigs(root)) {
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) {
      warnings.push(`Skipped project ${path.relative(root, configPath)}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
      continue;
    }

    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
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
