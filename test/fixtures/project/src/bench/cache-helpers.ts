export function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

export function sessionKeys(userId: string): string[] {
  const normalized = normalizeUserId(userId);
  return [`session:${normalized}`, `refresh:${normalized}`];
}

export class CacheStore {
  deleteMany(keys: string[]): number {
    return keys.length;
  }
}
