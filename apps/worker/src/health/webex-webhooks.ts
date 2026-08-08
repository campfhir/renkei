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
    console.warn('[worker] webhook health: PUBLIC_BASE_URL not set; skipping sweep');
    return;
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    console.error('[worker] webhook health: TOKEN_ENCRYPTION_KEY is missing or malformed');
    return;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    console.error('[worker] webhook health: database unavailable');
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
    console.error(
      '[worker] webhook health: could not enumerate tenants:',
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  for (const { tenant_id: tenantId } of tenantRows) {
    const configResult = await readConnectorConfigCached(tenantId, WEBEX_CONNECTOR, keyResult.val);
    if (!configResult.ok || !configResult.val?.enabled) continue;
    const botToken = configResult.val.secrets.botToken;
    const secret = configResult.val.secrets.webhookSecret;
    if (!botToken || !secret) {
      console.warn(
        `[worker] webhook health: tenant ${tenantId} is missing bot token or webhook secret`
      );
      continue;
    }

    const reconciled = await ensureWebexWebhooks(makeClient(botToken), {
      targetUrl: webexWebhookTargetUrl(baseUrl, tenantId),
      secret,
    });
    if (!reconciled.ok) {
      console.error(
        `[worker] webhook health: WebEx API error for tenant ${tenantId}; will retry next sweep`
      );
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
      console.warn(`[worker] webhook health: repaired tenant ${tenantId} — ${repairs}`);
    }
  }
}
