/**
 * Mapping a Zoom webhook delivery back to a user grant. Zoom deliveries
 * carry the meeting HOST's zoom user id (host_id) — which is exactly the
 * provider_account_id the OAuth callback stored — so the host's own grant
 * is the credential every re-fetch runs under. No grant means the host
 * never connected Zoom: their meetings are not ours to ingest, and the
 * caller skips WITHOUT failing (a retry cannot conjure a grant).
 *
 * The worker holds no token (docs/delegate-key-design.md, "Phase 1 as
 * built"): the fetcher rides the grant at the delegate, which refreshes
 * and deletes a revoked grant itself — so "revoked" reads as NO_GRANT here.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { ZOOM } from '@renkei/provider-grants';
import { logger } from '../logger';

export interface ZoomHostAccess {
  /** The host's grant fetcher; the delegate behind it supplies the credential. */
  auth: AuthedFetch;
  accountId: string;
  /** Lowercased — the refId owner segment. */
  hostEmail: string;
  /** The grant owner's subject — the ownerSubject for domain events.
   * Nullable in the schema; a grant without one cannot fire agents. */
  subject: string | null;
}

function describeHost(tenantId: string, accountId: string) {
  return delegateGrants().describe({ provider: ZOOM, accountId });
}

/**
 * The host's live Zoom access, or null when the host has no grant (skip).
 * Delegate problems still throw — those belong on last_error.
 */
export async function resolveZoomHostAccess(
  tenantId: string,
  hostId: string | null,
  hostEmail: string | null
): Promise<ZoomHostAccess | null> {
  // host_id is the stored provider_account_id; email is the fallback for
  // deliveries that carry only host_email (or whose host_id has no grant).
  let described = hostId ? await describeHost(tenantId, hostId) : null;
  if ((!described || (!described.ok && described.err.type === 'NO_GRANT')) && hostEmail) {
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const row = await dbResult.val
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('provider', '=', ZOOM)
      .where(sql<string>`metadata->>'email'`, '=', hostEmail.toLowerCase())
      .executeTakeFirst();
    if (row) described = await describeHost(tenantId, row.provider_account_id);
  }
  if (!described) return null;
  if (!described.ok) {
    if (described.err.type === 'NO_GRANT') {
      logger.info('no zoom grant for host {host}; skipping', {
        component: 'zoom/ingest',
        host: hostId ?? hostEmail ?? '(unknown)',
      });
      return null;
    }
    throw new Error(
      `could not read zoom grant for host ${hostId ?? hostEmail}: ${described.err.type}`
    );
  }
  const grant = described.val;

  const email =
    typeof grant.metadata.email === 'string' && grant.metadata.email
      ? grant.metadata.email.toLowerCase()
      : (hostEmail ?? '').toLowerCase();
  if (!email) {
    throw new Error(`zoom grant for ${grant.accountId} carries no email for refIds`);
  }

  return {
    auth: grantFetch({ provider: ZOOM, accountId: grant.accountId }),
    accountId: grant.accountId,
    hostEmail: email,
    subject: grant.subject,
  };
}
