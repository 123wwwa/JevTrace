import { verifyToken } from './jwt.js';

export async function refreshToken(token: string) {
  const payload = verifyToken(token);
  return payload.userId;
}
