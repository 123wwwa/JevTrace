import { PermissionRepository, hasPermission } from './permission-helpers.js';
import { audit, trace } from './noise.js';

const repository = new PermissionRepository();

export function authorizeRequest(userId: string, action: string): boolean {
  trace(action);
  const permissions = repository.findForUser(userId);
  audit(userId);
  return hasPermission(permissions, action);
}
