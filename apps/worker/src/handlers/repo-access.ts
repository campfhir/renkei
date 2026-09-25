/**
 * A pull-request subscriber's own live GitHub or Bitbucket access, for
 * the worker to re-fetch authoritative pipeline state and — when opted
 * in — merge the PR, exactly as they would from the browser. Mirrors
 * zoom-access.ts/atlassian-access.ts's shape: read the grant, refresh
 * proactively when near expiry (a sweep has no user to retry a 401 for),
 * throw on a configuration problem (surfaces on the dead-lettered
 * event's last_error), return null on no grant (skip, not a failure —
 * a retry cannot conjure one).
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  getGrant,
  refreshGrantTokens,
  readGitHubMetadata,
  readBitbucketMetadata,
  GitHubAdapter,
  BitbucketAdapter,
  GITHUB,
  ATLASSIAN_BITBUCKET,
} from '@renkei/provider-grants';
import { getDatabase } from '@renkei/db';
import { logger } from '../logger';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface RepoSubjectAccess {
  accessToken: string;
  login: string;
}

async function resolveSubjectAccess(
  tenantId: string,
  subject: string,
  provider: typeof GITHUB | typeof ATLASSIAN_BITBUCKET
): Promise<RepoSubjectAccess | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) throw new Error('TOKEN_ENCRYPTION_KEY is missing or malformed');

  const configResult = await readConnectorConfigCached(tenantId, provider, keyResult.val);
  if (!configResult.ok) {
    throw new Error(`could not read ${provider} connector config for tenant ${tenantId}`);
  }
  const config = configResult.val;
  const clientSecret = config?.secrets.clientSecret;
  if (!config || !config.enabled || typeof clientSecret !== 'string' || !clientSecret) {
    throw new Error(`${provider} connector is not configured or disabled for tenant ${tenantId}`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();
  if (!row) return null;

  const grantResult = await getGrant(provider, tenantId, row.provider_account_id, keyResult.val);
  if (!grantResult.ok || !grantResult.val) return null;
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const adapter = provider === GITHUB ? new GitHubAdapter(clientSecret) : new BitbucketAdapter(clientSecret);
    const refreshed = await refreshGrantTokens(adapter, tenantId, grant.accountId, keyResult.val, logger);
    if (!refreshed.ok) {
      if (refreshed.err.type === 'GRANT_REVOKED') {
        logger.warn('{provider} grant revoked during refresh; skipping', {
          component: 'repo/pr-pipeline-events',
          tenantId,
          provider,
        });
        return null;
      }
      throw new Error(`could not refresh ${provider} token for subject ${subject}`);
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }
  if (!grant.accessToken) return null;

  const login =
    provider === GITHUB
      ? readGitHubMetadata(grant.metadata).login
      : readBitbucketMetadata(grant.metadata).username;

  return { accessToken: grant.accessToken, login };
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
