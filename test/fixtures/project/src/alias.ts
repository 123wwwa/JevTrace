import { verifyToken } from '@jwt';

export function aliasEntry(token: string) {
  return verifyToken(token);
}
