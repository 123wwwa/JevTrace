export function createAccessToken(userId: string): string {
  return `access:${userId}`;
}
