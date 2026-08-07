/**
 * Utility functions for working with OIDC roles.
 * Roles are stored as comma-separated strings in cookies but used as Sets in code.
 */

/**
 * Parse roles from cookie string into a Set.
 */
export function parseRolesFromCookie(rolesStr: string | undefined): Set<string> {
  if (!rolesStr) return new Set();
  return new Set(
    rolesStr
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
  );
}

/**
 * Check if a role set has any of the required roles.
 */
export function hasAnyRole(userRoles: Set<string>, requiredRoles: string[]): boolean {
  return requiredRoles.some((role) => userRoles.has(role));
}

/**
 * Get the primary role from a set (for display purposes).
 */
export function getPrimaryRole(userRoles: Set<string>): string | null {
  return userRoles.size > 0 ? Array.from(userRoles)[0] : null;
}
