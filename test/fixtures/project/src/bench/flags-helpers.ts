export function loadFlagConfig(name: string) {
  return { name, rules: ['beta', 'staff'] };
}

export function normalizeRules(rules: string[]): string[] {
  return rules.map(rule => rule.trim().toLowerCase());
}

export function buildSegments(config: { rules: string[] }): string[] {
  return normalizeRules(config.rules);
}

export function evaluateSegments(user: string, segments: string[]): boolean {
  return segments.includes(user);
}
