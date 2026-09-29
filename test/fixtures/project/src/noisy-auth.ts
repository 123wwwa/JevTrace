import { verifyToken } from './jwt.js';
import { findUser } from './users.js';
import { createAccessToken } from './access.js';
import { auditRefresh, incrementMetric, logRequest } from './telemetry.js';

export function refreshTokenNoisy(token: string): string {
  logRequest(token);
  incrementMetric('refresh');

  const payload = verifyToken(token);
  const user = findUser(payload.userId);

  auditRefresh(user.id);
  return createAccessToken(user.id);
}
