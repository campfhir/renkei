/**
 * Slug → tenant resolution for the page tree.
 *
 * Pages are keyed by slug (readable), the API and the database by tenant id
 * (stable) — see docs/ui-shell-brief.md. Every `/[slug]/*` segment resolves
 * here once at the top and passes the id down; the slug is a lookup key, not
 * the internal identity.
 */

import { getDatabase } from '@renkei/db';

/**
 * Words a tenant slug must never claim: `/[slug]` shares the top level of the
 * URL space with these, so a tenant named `api` would shadow a real route.
 * `mcp` and `tenant` are the retired page prefixes — reserved so an old
 * bookmark can never resolve to somebody's organization.
 */
export const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'create-organization',
  'mcp',
  'tenant',
  '_next',
  'public',
  'favicon.ico',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

export interface TenantRef {
  id: string;
  slug: string;
}

/** The tenant this slug names, or null — callers 404 (pages) or 400 (routes). */
export async function tenantForSlug(slug: string): Promise<TenantRef | null> {
  if (isReservedSlug(slug)) return null;
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const tenant = await dbResult.val
    .selectFrom('tenants')
    .select(['id', 'slug'])
    .where('slug', '=', slug)
    .executeTakeFirst();
  return tenant ?? null;
}
