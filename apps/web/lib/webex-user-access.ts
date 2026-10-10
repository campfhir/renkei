/**
 * The caller's own WebEx OAuth access, by subject — the web-side twin of
 * the worker's resolver (apps/worker/src/handlers/webex-linked-user.ts).
 * Used by the all-spaces opt-in route, which registers webhooks as the
 * USER: no bot reads anything, so every WebEx capability stands on a
 * personal grant.
 *
 * No token is read here (docs/delegate-key-design.md): the delegate says
 * whether the grant exists and what it recorded about the person, and
 * hands back a fetcher that attaches and refreshes the credential itself.
 */

import { WEBEX_USER } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { getDatabase } from '@renkei/db';

export interface WebexUserAccess {
  accountId: string;
  /** `fetch` on this person's WebEx grant; the delegate supplies the credential. */
  auth: AuthedFetch;
  metadata: Record<string, unknown>;
}

export async function resolveWebexUserAccess(
  subject: string
): Promise<WebexUserAccess | null> {
  const described = await delegateGrants().describe({ provider: WEBEX_USER, subject });
  if (!described.ok) return null;
  const accountId = described.val.accountId;
  return {
    accountId,
    auth: grantFetch({ provider: WEBEX_USER, accountId }),
    metadata: { ...described.val.metadata },
  };
}

/**
 * The by-EMAIL variant — the knowledge gate identifies the acting user by
 * their verified email, not their subject; identities is the bridge.
 */
export async function resolveWebexUserAccessByEmail(
  email: string
): Promise<WebexUserAccess | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('identities')
    .select('subject')
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (!row) return null;
  return resolveWebexUserAccess(row.subject);
}
