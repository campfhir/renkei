/**
 * Mapping a WebEx message's sender back to their own Renkei account and, if
 * they have one, their own WebEx OAuth grant.
 *
 * The bot's ambient webhook only carries personEmail. The identity spine
 * (identities table, keyed by tenant+email — see apps/web/lib/identity.ts)
 * is where that turns into "does this person have a Renkei account at all";
 * a further hop to provider_grants is where it turns into "can Renkei act
 * as them against WebEx". The two questions have different failure modes:
 * no identity means nudge them to sign in (ambientHandler's job); an
 * identity with no webex-user grant means an account that simply has not
 * connected WebEx yet — ambient capture still runs, just without the
 * cross-space forwarded-message search in webex-forward-context.ts.
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
import { logger } from '../logger';

/** The webex-user connector key — see apps/web/lib/webex-app.ts. */
const WEBEX_USER_CONNECTOR = 'webex-user';
/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * Does this tenant have a recorded Renkei identity for this email — has this
 * person ever signed in? A DB error is a caller problem (thrown, so the
 * event's retry budget applies); "no row" is the ordinary unregistered case.
 */
export async function hasLinkedIdentity(tenantId: string, email: string): Promise<boolean> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');

  const row = await dbResult.val
    .selectFrom('identities')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  return Boolean(row);
}

export interface LinkedWebexUserAccess {
  accessToken: string;
}

/**
 * The sender's own WebEx OAuth access token, or null when they have not
 * connected WebEx, the platform-level integration is unconfigured, or the
 * refresh failed. Always best-effort: the cross-space search this feeds is
 * an enrichment, never a reason to fail the event.
 */
export async function resolveLinkedWebexUserAccess(
  tenantId: string,
  email: string
): Promise<LinkedWebexUserAccess | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.warn('TOKEN_ENCRYPTION_KEY is missing or malformed; skipping cross-space search', {
      component: 'webex/forward-context',
      tenantId,
    });
    return null;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.warn('database unavailable; skipping cross-space search', {
      component: 'webex/forward-context',
      tenantId,
    });
    return null;
  }

  // Same identities → provider_grants hop the knowledge gate uses for
  // Atlassian (apps/web/lib/mcp-tools/knowledge/index.ts): the gates verify
  // by email, grants are keyed by subject, identities is the bridge.
  const row = await dbResult.val
    .selectFrom('identities')
    .innerJoin('provider_grants', (join) =>
      join
        .onRef('provider_grants.subject', '=', 'identities.subject')
        .onRef('provider_grants.tenant_id', '=', 'identities.tenant_id')
    )
    .select('provider_grants.provider_account_id')
    .where('identities.tenant_id', '=', tenantId)
    .where('identities.email', '=', email.toLowerCase())
    .where('provider_grants.provider', '=', WEBEX_USER)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    logger.debug('no webex-user grant on file for {email}; skipping cross-space search', {
      component: 'webex/forward-context',
      tenantId,
      email,
    });
    return null;
  }

  const grantResult = await getGrant(WEBEX_USER, tenantId, row.provider_account_id, keyResult.val);
  if (!grantResult.ok || !grantResult.val) {
    logger.warn('webex-user grant row exists but could not be read: {error}', {
      component: 'webex/forward-context',
      tenantId,
      email,
      error: grantResult.ok ? 'grant not found' : grantResult.err,
    });
    return null;
  }
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    logger.debug('sender’s webex-user token is near expiry; refreshing', {
      component: 'webex/forward-context',
      tenantId,
      email,
    });
    const configResult = await readConnectorConfigCached(
      tenantId,
      WEBEX_USER_CONNECTOR,
      keyResult.val
    );
    const clientSecret = configResult.ok ? configResult.val?.secrets.clientSecret : undefined;
    if (!clientSecret) {
      logger.warn('webex-user connector has no clientSecret; skipping cross-space search', {
        component: 'webex/forward-context',
        tenantId,
      });
      return null;
    }

    const refreshed = await refreshGrantTokens(
      new WebexUserAdapter(clientSecret),
      tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      logger.warn('could not refresh sender’s webex grant; skipping cross-space search', {
        component: 'webex/forward-context',
        tenantId,
      });
      return null;
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  return { accessToken: grant.accessToken };
}

export interface WebexUserGrantAccess {
  accessToken: string;
  subject: string;
}

/**
 * A grant's own access by ACCOUNT id — how the all-spaces webhook handler
 * turns a delivery back into "whose webhook, acting with whose token".
 * Same refresh path as the by-email resolver above.
 */
export async function resolveWebexUserAccessByAccount(
  tenantId: string,
  accountId: string
): Promise<WebexUserGrantAccess | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('provider_account_id', '=', accountId)
    .executeTakeFirst();
  if (!row?.subject) return null;

  const grantResult = await getGrant(WEBEX_USER, tenantId, accountId, keyResult.val);
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

  return { accessToken: grant.accessToken, subject: row.subject };
}

/**
 * The by-SUBJECT variant — the reply handler knows the run's owner, not
 * their account id.
 */
export async function resolveWebexUserAccessBySubject(
  tenantId: string,
  subject: string
): Promise<WebexUserGrantAccess | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('subject', '=', subject)
    .executeTakeFirst();
  if (!row) return null;
  return resolveWebexUserAccessByAccount(tenantId, row.provider_account_id);
}
