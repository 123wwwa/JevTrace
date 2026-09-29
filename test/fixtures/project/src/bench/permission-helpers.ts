export class PermissionRepository {
  findForUser(userId: string): string[] {
    return expandRoles(userId === 'admin' ? ['admin'] : ['reader']);
  }
}

export function expandRoles(roles: string[]): string[] {
  return roles.includes('admin') ? [...roles, 'write', 'read'] : roles;
}

export function hasPermission(permissions: string[], action: string): boolean {
  return permissions.includes(action);
}
