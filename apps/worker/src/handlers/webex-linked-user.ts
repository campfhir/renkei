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
 *
 * The worker holds no token (docs/delegate-key-design.md, "Phase 1 as
 * built"): each resolver hands back the grant's fetcher, and the delegate
 * behind it attaches the credential and refreshes it when due.
 */

import { getDatabase } from '@renkei/db';
import {
  delegateGrants,
  grantFetch,
  type AuthedFetch,
  type GrantRef,
} from '@renkei/delegate-client';
import { WEBEX_USER } from '@renkei/provider-grants';
import { logger } from '../logger';

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
  /** The sender's grant fetcher; the delegate behind it supplies the credential. */
  auth: AuthedFetch;
}

/**
 * The sender's own WebEx access, or null when they have not connected
 * WebEx or their grant cannot be read. Always best-effort: the cross-space
 * search this feeds is an enrichment, never a reason to fail the event.
 */
export async function resolveLinkedWebexUserAccess(
  tenantId: string,
  email: string
): Promise<LinkedWebexUserAccess | null> {
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

  const grant: GrantRef = { tenantId, provider: WEBEX_USER, accountId: row.provider_account_id };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) {
    logger.warn('webex-user grant row exists but could not be read: {error}', {
      component: 'webex/forward-context',
      tenantId,
      email,
      error: described.err.type,
    });
    return null;
  }

  return { auth: grantFetch(grant) };
}

export interface WebexUserGrantAccess {
  /** The grant's fetcher; the delegate behind it supplies the credential. */
  auth: AuthedFetch;
  subject: string;
  /** The WebEx address the grant recorded — how the org bot addresses this person. */
  personEmail: string | null;
}

/** The grant the ref names, as the handlers act with it; null when it has no subject or cannot be read. */
async function resolveWebexUserAccess(ref: GrantRef): Promise<WebexUserGrantAccess | null> {
  const described = await delegateGrants().describe(ref);
  if (!described.ok) return null;
  const grant = described.val;
  if (!grant.subject) return null;
  return {
    auth: grantFetch({ tenantId: ref.tenantId, provider: WEBEX_USER, accountId: grant.accountId }),
    subject: grant.subject,
    personEmail: typeof grant.metadata.personEmail === 'string' ? grant.metadata.personEmail : null,
  };
}

/**
 * A grant's own access by ACCOUNT id — how the all-spaces webhook handler
 * turns a delivery back into "whose webhook, acting with whose grant".
 */
export function resolveWebexUserAccessByAccount(
  tenantId: string,
  accountId: string
): Promise<WebexUserGrantAccess | null> {
  return resolveWebexUserAccess({ tenantId, provider: WEBEX_USER, accountId });
}

/**
 * The by-SUBJECT variant — the reply handler knows the run's owner, not
 * their account id.
 */
export function resolveWebexUserAccessBySubject(
  tenantId: string,
  subject: string
): Promise<WebexUserGrantAccess | null> {
  return resolveWebexUserAccess({ tenantId, provider: WEBEX_USER, subject });
}
