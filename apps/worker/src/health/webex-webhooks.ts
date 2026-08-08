/**
 * Periodic webhook health: the worker half of "connectors silently rot"
 * (RENKEI.md). Webhooks get deleted out from under us, and WebEx flips
 * persistently-failing ones to inactive — after which events just stop,
 * with nothing in Renkei to notice. This sweep notices: every interval it
 * reconciles each enabled tenant's registrations toward the required set,
 * and logs loudly whenever it had to repair something, because a repair
 * means events were being lost until now.
 *
 * The sweep needs the stored public base URL — the worker serves no
 * requests, so there is no origin to fall back on. Until an operator sets
 * it, the sweep skips with a warning rather than registering webhooks that
 * point somewhere wrong.
 */

import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { getPublicBaseUrl } from '@renkei/settings';
import { logger } from '../logger';
import {
  WEBEX_CONNECTOR,
  WebexClient,
  webexWebhookTargetUrl,
  ensureWebexWebhooks,
} from '@renkei/connector-webex';
import type { WebexWebhooksClient } from '@renkei/connector-webex';

/** How often the worker re-checks every tenant's webhooks. */
export const WEBHOOK_HEALTH_INTERVAL_MS = 15 * 60_000;

export interface WebhookSweepDeps {
  /** Test hook: build the WebEx client for a tenant's bot token. */
  makeClient?: (botToken: string) => WebexWebhooksClient;
}

/**
 * One reconciliation pass over every tenant with an enabled WebEx
 * connector. Per-tenant failures are logged and skipped — one tenant's
 * broken bot token must not stop the sweep for the rest.
 */
export async function sweepWebexWebhooks(deps: WebhookSweepDeps = {}): Promise<void> {
  const makeClient = deps.makeClient ?? ((botToken: string) => new WebexClient(botToken));

  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    logger.warn('PUBLIC_BASE_URL not set; skipping sweep', { component: 'webex/webhook-health' });
    return;
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'webex/webhook-health',
    });
    return;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('database unavailable', { component: 'webex/webhook-health' });
    return;
  }

  let tenantRows: Array<{ tenant_id: string }>;
  try {
    tenantRows = await dbResult.val
      .selectFrom('connector_configs')
      .select('tenant_id')
      .where('connector', '=', WEBEX_CONNECTOR)
      .where('enabled', '=', true)
      .execute();
  } catch (error) {
    logger.error('could not enumerate tenants: {error}', {
      component: 'webex/webhook-health',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const { tenant_id: tenantId } of tenantRows) {
    const configResult = await readConnectorConfigCached(tenantId, WEBEX_CONNECTOR, keyResult.val);
    if (!configResult.ok || !configResult.val?.enabled) continue;
    const botToken = configResult.val.secrets.botToken;
    const secret = configResult.val.secrets.webhookSecret;
    if (!botToken || !secret) {
      logger.warn('tenant is missing bot token or webhook secret', {
        component: 'webex/webhook-health',
        tenantId,
      });
      continue;
    }

    const reconciled = await ensureWebexWebhooks(makeClient(botToken), {
      targetUrl: webexWebhookTargetUrl(baseUrl, tenantId),
      secret,
    });
    if (!reconciled.ok) {
      logger.error('WebEx API error; will retry next sweep', {
        component: 'webex/webhook-health',
        tenantId,
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
      // Loud on purpose: a repair means deliveries were being lost until now.
      logger.warn('repaired webhooks: {repairs}', {
        component: 'webex/webhook-health',
        tenantId,
        repairs,
      });
    }
  }
}
