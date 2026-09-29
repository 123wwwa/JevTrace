import { refreshToken } from './auth.js';

export const savedReference = refreshToken;

export async function testRefresh() {
  return refreshToken('test-token');
}
