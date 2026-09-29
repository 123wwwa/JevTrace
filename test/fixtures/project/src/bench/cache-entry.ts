import { CacheStore, sessionKeys } from './cache-helpers.js';
import { audit, metric } from './noise.js';

const cache = new CacheStore();

export function invalidateUserSession(userId: string): number {
  audit(userId);
  const keys = sessionKeys(userId);
  metric('session.invalidate');
  return cache.deleteMany(keys);
}
