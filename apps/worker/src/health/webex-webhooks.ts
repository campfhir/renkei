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
 *
 * Unlike content polling, this check is pure overhead when nothing has
 * rotted — one `/webhooks` call per opted-in grant, on that grant's own
 * token, purely to confirm what is usually already fine. Checking every
 * grant on every wake tripped WebEx's rate limit on tenants with many
 * opted-in users (repeated 429s from `/webhooks`), so due-time is tracked
 * per grant the same way the content-watch sweep does: the outer cadence
 * (`WEBHOOK_HEALTH_INTERVAL_MS`) is a floor, and each tenant's
 * `webexWebhookHealthMinutes` decides how long a grant may go unchecked
 * beyond it.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl, getOrgSettings } from '@renkei/settings';
import { logger } from '../logger';
import {
  WebexClient,
  webexUserWebhookTargetUrl,
  ensureWebexWebhooks,
} from '@renkei/connector-webex';
import type { WebexWebhooksClient } from '@renkei/connector-webex';
import { resolveWebexUserAccessByAccount } from '../handlers/webex-linked-user';

/** How often the worker wakes to look for a due grant; per-grant due-time does the real pacing. */
export const WEBHOOK_HEALTH_INTERVAL_MS = 15 * 60_000;

/** The floor of the per-org dial (`webexWebhookHealthMinutes`). */
const MIN_CHECK_DUE_MS = 15 * 60_000;

export interface WebhookSweepDeps {
  /** Test hook: build the WebEx client for a user's access token. */
  makeClient?: (accessToken: string) => WebexWebhooksClient;
  resolveAccess?: typeof resolveWebexUserAccessByAccount;
  now?: () => Date;
}

/**
 * One reconciliation pass over every opted-in all-spaces grant. Per-grant
 * failures are logged and skipped — one user's dead token must not stop
 * the sweep for everyone else.
 */
export async function sweepWebexWebhooks(deps: WebhookSweepDeps = {}): Promise<void> {
  const makeClient = deps.makeClient ?? ((token: string) => new WebexClient(token));
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;
  const now = (deps.now ?? (() => new Date()))();

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
  const db = dbResult.val;

  let grantRows: Array<{ tenant_id: string; provider_account_id: string; metadata: unknown }>;
  try {
    grantRows = await db
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

  // The org dial: each tenant's webexWebhookHealthMinutes decides how long a
  // grant may go unchecked. Settings are cached (60s) per tenant, so this
  // costs one read per tenant per pass, not per grant.
  const dueMsByTenant = new Map<string, number>();
  const dueMsFor = async (tenantId: string): Promise<number> => {
    const cached = dueMsByTenant.get(tenantId);
    if (cached !== undefined) return cached;
    const floorMinutes = MIN_CHECK_DUE_MS / 60_000;
    const settings = await getOrgSettings(tenantId);
    const minutes = settings.ok
      ? Math.max(floorMinutes, settings.val.webexWebhookHealthMinutes)
      : floorMinutes;
    const ms = minutes * 60_000;
    dueMsByTenant.set(tenantId, ms);
    return ms;
  };

  for (const row of grantRows) {
    const metadata: { allSpacesSecret?: unknown; webhookHealthCheckedAt?: unknown } =
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? row.metadata
        : {};
    const secret = typeof metadata.allSpacesSecret === 'string' ? metadata.allSpacesSecret : null;
    if (!secret) continue;

    const checkedAt =
      typeof metadata.webhookHealthCheckedAt === 'string'
        ? new Date(metadata.webhookHealthCheckedAt)
        : null;
    const dueMs = await dueMsFor(row.tenant_id);
    if (
      checkedAt &&
      !Number.isNaN(checkedAt.getTime()) &&
      now.getTime() - checkedAt.getTime() < dueMs
    ) {
      continue; // checked recently enough; leave this grant's token quota alone
    }

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
    // Recorded regardless of outcome — including a 429 — so a failing check
    // backs off to the same per-tenant interval instead of retrying (and
    // likely failing again) on every future wake of the outer sweep.
    await db
      .updateTable('provider_grants')
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          webhookHealthCheckedAt: now.toISOString(),
        })}::jsonb`,
      })
      .where('tenant_id', '=', row.tenant_id)
      .where('provider', '=', 'webex')
      .where('provider_account_id', '=', row.provider_account_id)
      .execute();

    if (!reconciled.ok) {
      logger.error('WebEx API error; will retry in {minutes}m: {kind} {message}', {
        component: 'webex/webhook-health',
        tenantId: row.tenant_id,
        minutes: Math.round(dueMs / 60_000),
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
