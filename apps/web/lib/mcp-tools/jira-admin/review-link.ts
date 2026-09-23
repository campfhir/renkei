/**
 * Where a person reviews a Jira admin change request: the page every
 * proposal tool links to, since applying happens there and nowhere else.
 */

import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import type { MCPToolContext } from '../common';

/**
 * The review page's URL, less the request's id: absolute when the
 * deployment knows its address. Pages are keyed by the tenant's slug.
 */
export async function reviewPrefix(context: MCPToolContext): Promise<string> {
  const dbResult = getDatabase();
  const tenant = dbResult.ok
    ? await dbResult.val
        .selectFrom('tenants')
        .select('slug')
        .where('id', '=', context.tenantId)
        .executeTakeFirst()
    : undefined;
  const base = context.origin || getPublicBaseUrl() || '';
  return `${base}/${tenant?.slug ?? ''}/jira-admin/changes/`;
}
