import { buildSegments, evaluateSegments, loadFlagConfig } from './flags-helpers.js';
import { metric, trace } from './noise.js';

export function resolveFeatureFlag(user: string, name: string): boolean {
  trace(name);
  const config = loadFlagConfig(name);
  const segments = buildSegments(config);
  metric('flag.evaluate');
  return evaluateSegments(user, segments);
}
