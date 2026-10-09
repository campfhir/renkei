/**
 * A pull-request subscriber's own live GitHub or Bitbucket access, for
 * the worker to re-fetch authoritative pipeline state and — when opted
 * in — merge the PR, exactly as they would from the browser. Mirrors
 * zoom-access.ts/atlassian-access.ts's shape: describe the grant at the
 * delegate, throw on a delegate problem (surfaces on the dead-lettered
 * event's last_error), return null on no grant (skip, not a failure —
 * a retry cannot conjure one). The fetcher's credential lives at the
 * delegate, which refreshes it; the worker never sees a token.
 */

import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import {
  readGitHubMetadata,
  readBitbucketMetadata,
  GITHUB,
  ATLASSIAN_BITBUCKET,
} from '@renkei/provider-grants';

export interface RepoSubjectAccess {
  /** The subscriber's grant fetcher; the delegate behind it supplies the credential. */
  auth: AuthedFetch;
  login: string;
}

async function resolveSubjectAccess(
  tenantId: string,
  subject: string,
  provider: typeof GITHUB | typeof ATLASSIAN_BITBUCKET
): Promise<RepoSubjectAccess | null> {
  const described = await delegateGrants().describe({ provider, subject });
  if (!described.ok) {
    if (described.err.type === 'NO_GRANT') return null;
    throw new Error(
      `could not read ${provider} grant for subject ${subject}: ${described.err.type}`
    );
  }
  const grant = described.val;

  const login =
    provider === GITHUB
      ? readGitHubMetadata(grant.metadata).login
      : readBitbucketMetadata(grant.metadata).username;

  return { auth: grantFetch({ provider, accountId: grant.accountId }), login };
}

export function resolveGitHubSubjectAccess(
  tenantId: string,
  subject: string
): Promise<RepoSubjectAccess | null> {
  return resolveSubjectAccess(tenantId, subject, GITHUB);
}

export function resolveBitbucketSubjectAccess(
  tenantId: string,
  subject: string
): Promise<RepoSubjectAccess | null> {
  return resolveSubjectAccess(tenantId, subject, ATLASSIAN_BITBUCKET);
}
