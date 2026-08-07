/**
 * Which files in the migrations directory are migrations. The directory also
 * holds the runner, the status module, and tests — importing those as
 * migrations detonates (status.test.ts references jest at module scope), so
 * both the runtime provider and the production bundle build filter with this.
 */
export function isMigrationFile(name: string): boolean {
  return /^\d{3}-.*\.(ts|js|mjs|cjs)$/.test(name);
}
