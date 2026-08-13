import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';

/**
 * `${base}/${tenant.slug}` — where the deployment lives for a tenant, or
 * null when either the deployment has no PUBLIC_BASE_URL or the tenant id
 * does not resolve (should not happen: the webhook route validates it before
 * an event row is ever written). Shared by cardsFeedUrl and registrationUrl.
 */
async function tenantUrl(tenantId: string): Promise<string | null> {
  const base = getPublicBaseUrl();
  if (!base) return null;

  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const tenant = await dbResult.val
    .selectFrom('tenants')
    .select('slug')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  return tenant ? `${base}/${tenant.slug}` : null;
}

/**
 * Where the card feed lives for a tenant, for confirmation links in WebEx
 * messages. Pages are keyed by slug (docs/ui-shell-brief.md). Null when the
 * deployment or tenant does not resolve — the caller words its confirmation
 * without a link.
 */
export async function cardsFeedUrl(tenantId: string): Promise<string | null> {
  // The tenant root IS the feed — `/home` still redirects there, but linking
  // through a redirect for every card confirmation is a wasted hop.
  return tenantUrl(tenantId);
}

/**
 * Where someone with no Renkei account yet should go to sign in — the
 * tenant's base URL. Visiting it while signed out is what creates the
 * identities row (apps/web/lib/identity.ts) the ambient handler checks for
 * on the next message. Null on the same conditions as cardsFeedUrl.
 */
export async function registrationUrl(tenantId: string): Promise<string | null> {
  return tenantUrl(tenantId);
}
