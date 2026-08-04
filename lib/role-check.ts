export function hasRole(role: string, rolesStr: string | undefined | null): boolean {
  if (!rolesStr) return false;
  const roles = rolesStr.split(',').map((r) => r.trim());
  return roles.includes(role);
}

export function parseRoles(rolesStr: string | undefined | null): string[] {
  if (!rolesStr) return [];
  return rolesStr.split(',').map((r) => r.trim());
}
