/**
 * Periodic webhook health for the all-spaces registrations: the worker
 * half of "connectors silently rot" (RENKEI.md). WebEx deletes webhooks
 * out from under us and flips persistently-failing ones to inactive —
 * after which deliveries silently stop, with nothing to notice.
 * This sweep notices: every interval it reconciles each OPTED-IN grant's
 * registration (made with that user's own token — there is no bot) toward
 * the required single webhook, and logs loudly on every repair, because a
 * repair means events were being lost until now.
 *
 * The sweep needs the stored public base URL — the worker serves no
 * requests, so there is no origin to fall back on. Until an operator sets
 * it, the sweep skips with a warning rather than registering webhooks
 * that point somewhere wrong.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { logger } from '../logger';
import {
  WebexClient,
  webexUserWebhookTargetUrl,
  ensureWebexWebhooks,
} from '@renkei/connector-webex';
import type { WebexWebhooksClient } from '@renkei/connector-webex';
import { resolveWebexUserAccessByAccount } from '../handlers/webex-linked-user';

/** How often the worker re-checks every opted-in grant's webhook. */
export const WEBHOOK_HEALTH_INTERVAL_MS = 15 * 60_000;

export interface WebhookSweepDeps {
  /** Test hook: build the WebEx client for a user's access token. */
  makeClient?: (accessToken: string) => WebexWebhooksClient;
  resolveAccess?: typeof resolveWebexUserAccessByAccount;
}

/**
 * One reconciliation pass over every opted-in all-spaces grant. Per-grant
 * failures are logged and skipped — one user's dead token must not stop
 * the sweep for everyone else.
 */
export async function sweepWebexWebhooks(deps: WebhookSweepDeps = {}): Promise<void> {
  const makeClient = deps.makeClient ?? ((token: string) => new WebexClient(token));
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;

  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    logger.warn('PUBLIC_BASE_URL not set; skipping sweep', { component: 'webex/webhook-health' });
    return;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('database unavailable', { component: 'webex/webhook-health' });
    return;
  }

  let grantRows: Array<{ tenant_id: string; provider_account_id: string; metadata: unknown }>;
  try {
    grantRows = await dbResult.val
      .selectFrom('provider_grants')
      .select(['tenant_id', 'provider_account_id', 'metadata'])
      .where('provider', '=', 'webex')
      .where(sql<boolean>`metadata->>'allSpaces' = 'true'`)
      .execute();
  } catch (error) {
    logger.error('could not enumerate opted-in grants: {error}', {
      component: 'webex/webhook-health',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const row of grantRows) {
    const metadata: { allSpacesSecret?: unknown } =
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? row.metadata
        : {};
    const secret = typeof metadata.allSpacesSecret === 'string' ? metadata.allSpacesSecret : null;
    if (!secret) continue;

    const access = await resolveAccess(row.tenant_id, row.provider_account_id);
    if (!access) {
      logger.warn('opted-in grant has no usable token; webhook may rot', {
        component: 'webex/webhook-health',
        tenantId: row.tenant_id,
      });
      continue;
    }

    const reconciled = await ensureWebexWebhooks(makeClient(access.accessToken), {
      targetUrl: webexUserWebhookTargetUrl(baseUrl, row.tenant_id, row.provider_account_id),
      secret,
    });
    if (!reconciled.ok) {
      logger.error('WebEx API error; will retry next sweep: {kind} {message}', {
        component: 'webex/webhook-health',
        tenantId: row.tenant_id,
        kind: reconciled.err.type,
        message:
          typeof reconciled.err.message === 'string' ? reconciled.err.message.slice(0, 300) : '',
      });
      continue;
    }
    if (reconciled.val.changed) {
      const repairs = reconciled.val.registrations
        .filter((registration) => registration.action !== 'kept')
        .map(
          (registration) => `${registration.resource}/${registration.event} ${registration.action}`
        )
        .join(', ');
      logger.warn('repaired all-spaces webhook: {repairs} — events were being lost', {
        component: 'webex/webhook-health',
        tenantId: row.tenant_id,
        repairs,
      });
    }
  }
}
