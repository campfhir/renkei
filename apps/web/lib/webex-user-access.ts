/**
 * The caller's own WebEx OAuth access, by subject — the web-side twin of
 * the worker's resolver (apps/worker/src/handlers/webex-linked-user.ts).
 * Used by the all-spaces opt-in route, which registers webhooks with the
 * USER's token: there is no bot anymore, so every WebEx capability stands
 * on a personal grant.
 */

import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  getGrant,
  refreshGrantTokens,
  WEBEX_USER,
  WebexUserAdapter,
} from '@renkei/provider-grants';
import { WEBEX_USER_CONNECTOR } from '@/lib/webex-app';
import { logger } from '@/lib/logger';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface WebexUserAccess {
  accountId: string;
  accessToken: string;
  metadata: Record<string, unknown>;
}

export async function resolveWebexUserAccess(
  tenantId: string,
  subject: string
): Promise<WebexUserAccess | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('subject', '=', subject)
    .executeTakeFirst();
  if (!row) return null;

  const grantResult = await getGrant(WEBEX_USER, tenantId, row.provider_account_id, keyResult.val);
  if (!grantResult.ok || !grantResult.val) return null;
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const configResult = await readConnectorConfigCached(
      tenantId,
      WEBEX_USER_CONNECTOR,
      keyResult.val
    );
    const clientSecret = configResult.ok ? configResult.val?.secrets.clientSecret : undefined;
    if (!clientSecret) return null;
    const refreshed = await refreshGrantTokens(
      new WebexUserAdapter(clientSecret),
      tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) return null;
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const metadata: Record<string, unknown> =
    typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? { ...row.metadata }
      : {};
  return { accountId: row.provider_account_id, accessToken: grant.accessToken, metadata };
}

/**
 * The by-EMAIL variant — the knowledge gate identifies the acting user by
 * their verified email, not their subject; identities is the bridge.
 */
export async function resolveWebexUserAccessByEmail(
  tenantId: string,
  email: string
): Promise<WebexUserAccess | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('identities')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (!row) return null;
  return resolveWebexUserAccess(tenantId, row.subject);
}
