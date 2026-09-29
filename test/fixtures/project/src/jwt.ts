export interface TokenPayload { userId: string }

export function decodeJWT(token: string): TokenPayload {
  return { userId: token };
}

export function verifyToken(token: string): TokenPayload {
  return decodeJWT(token);
}
