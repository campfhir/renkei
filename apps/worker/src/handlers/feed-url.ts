import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';

/**
 * Where the card feed lives for a tenant, for confirmation links in WebEx
 * messages. Pages are keyed by slug (docs/ui-shell-brief.md), so the tenant
 * id on the event is resolved to its slug here. Null when the deployment has
 * no PUBLIC_BASE_URL — the caller words its confirmation without a link.
 */
export async function cardsFeedUrl(tenantId: string): Promise<string | null> {
  const base = getPublicBaseUrl();
  if (!base) return null;

  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const tenant = await dbResult.val
    .selectFrom('tenants')
    .select('slug')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  return tenant ? `${base}/${tenant.slug}/home` : null;
}
