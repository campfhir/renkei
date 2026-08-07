/**
 * Webhook self-management: Renkei holds the bot token, so Renkei — not an
 * operator with curl — is the right party to register its own webhooks and
 * notice when they rot. This is the "connectors silently rot" observability
 * concern from RENKEI.md made concrete for WebEx: webhooks can be deleted
 * out from under us, and WebEx flips persistently-failing ones to
 * `inactive`, after which events silently stop.
 *
 * Two operations over the same matching logic:
 *  - inspect: read-only health report (the admin GET, and dashboards later)
 *  - ensure: reconcile toward the required set — create what's missing,
 *    recreate what's inactive or signing with the wrong secret, delete
 *    duplicates. Idempotent; a healthy tenant reconciles to "kept".
 *
 * A webhook counts as healthy only if its status is active AND its secret
 * (when WebEx echoes it) matches the tenant's stored webhook secret — a
 * webhook signing with a stale secret delivers events Renkei rejects with
 * 401s, which is exactly the silent-rot failure mode.
 */

import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { WebexClient, WebexWebhook } from './client';

/** The slice of the client this module needs — what tests stub. */
export type WebexWebhooksClient = Pick<
  WebexClient,
  'listWebhooks' | 'createWebhook' | 'deleteWebhook'
>;

export interface RequiredWebhook {
  resource: string;
  event: string;
  name: string;
}

/**
 * The registrations Renkei's WebEx connector needs: ambient message
 * ingestion, and the Action.Submit events behind "Push to Renkei".
 */
export const REQUIRED_WEBEX_WEBHOOKS: readonly RequiredWebhook[] = [
  { resource: 'messages', event: 'created', name: 'Renkei ingestion' },
  { resource: 'attachmentActions', event: 'created', name: 'Renkei push-to-renkei' },
];

/** The receipt endpoint a tenant's webhooks must target. */
export function webexWebhookTargetUrl(publicBaseUrl: string, tenantId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/api/webhooks/webex/${encodeURIComponent(tenantId)}`;
}

export type WebhookHealthState = 'ok' | 'missing' | 'inactive' | 'secret-mismatch' | 'duplicate';

export interface WebhookHealth {
  resource: string;
  event: string;
  state: WebhookHealthState;
  webhookId: string | null;
  /** WebEx's own status string, when a matching webhook exists. */
  status: string | null;
}

export interface WebhookInspection {
  healthy: boolean;
  registrations: WebhookHealth[];
}

export type WebhookRepairAction = 'kept' | 'created' | 'recreated' | 'deduplicated';

export interface WebhookRepair {
  resource: string;
  event: string;
  action: WebhookRepairAction;
  webhookId: string;
}

export interface WebhookReconciliation {
  /** True when anything had to be created, recreated, or cleaned up. */
  changed: boolean;
  registrations: WebhookRepair[];
}

function matches(hook: WebexWebhook, targetUrl: string, required: RequiredWebhook): boolean {
  return (
    hook.targetUrl === targetUrl &&
    hook.resource === required.resource &&
    hook.event === required.event
  );
}

function isHealthy(hook: WebexWebhook, secret: string): boolean {
  // A null echoed secret is indistinguishable from a matching one; only a
  // definite mismatch condemns the webhook.
  return hook.status === 'active' && (hook.secret === null || hook.secret === secret);
}

/**
 * Read-only health report against the required set. `secret` is the
 * tenant's stored webhook secret, used only for comparison — it never
 * appears in the report.
 */
export async function inspectWebexWebhooks(
  client: WebexWebhooksClient,
  targetUrl: string,
  secret: string
): Promise<Result<WebhookInspection, 'WEBEX_API_ERROR'>> {
  const listed = await client.listWebhooks();
  if (!listed.ok) return listed;

  const registrations = REQUIRED_WEBEX_WEBHOOKS.map((required): WebhookHealth => {
    const found = listed.val.filter((hook) => matches(hook, targetUrl, required));
    const base = { resource: required.resource, event: required.event };
    if (found.length === 0) {
      return { ...base, state: 'missing', webhookId: null, status: null };
    }
    const healthy = found.find((hook) => isHealthy(hook, secret));
    if (!healthy) {
      const first = found[0]!;
      const state = first.status === 'active' ? 'secret-mismatch' : 'inactive';
      return { ...base, state, webhookId: first.id, status: first.status };
    }
    if (found.length > 1) {
      return { ...base, state: 'duplicate', webhookId: healthy.id, status: healthy.status };
    }
    return { ...base, state: 'ok', webhookId: healthy.id, status: healthy.status };
  });

  return ok({
    healthy: registrations.every((registration) => registration.state === 'ok'),
    registrations,
  });
}

/**
 * Reconcile the bot's webhooks toward the required set. Any failure along
 * the way surfaces as WEBEX_API_ERROR so the caller retries the whole sweep
 * — every step is idempotent, so re-running after a partial repair is safe.
 */
export async function ensureWebexWebhooks(
  client: WebexWebhooksClient,
  options: { targetUrl: string; secret: string }
): Promise<Result<WebhookReconciliation, 'WEBEX_API_ERROR'>> {
  const listed = await client.listWebhooks();
  if (!listed.ok) return listed;

  const registrations: WebhookRepair[] = [];
  for (const required of REQUIRED_WEBEX_WEBHOOKS) {
    const found = listed.val.filter((hook) => matches(hook, options.targetUrl, required));
    const healthy = found.find((hook) => isHealthy(hook, options.secret));
    const base = { resource: required.resource, event: required.event };

    if (healthy) {
      const strays = found.filter((hook) => hook.id !== healthy.id);
      for (const stray of strays) {
        const deleted = await client.deleteWebhook(stray.id);
        if (!deleted.ok) return deleted;
      }
      registrations.push({
        ...base,
        action: strays.length > 0 ? 'deduplicated' : 'kept',
        webhookId: healthy.id,
      });
      continue;
    }

    for (const hook of found) {
      const deleted = await client.deleteWebhook(hook.id);
      if (!deleted.ok) return deleted;
    }
    const created = await client.createWebhook({
      name: required.name,
      targetUrl: options.targetUrl,
      resource: required.resource,
      event: required.event,
      secret: options.secret,
    });
    if (!created.ok) return created;
    registrations.push({
      ...base,
      action: found.length > 0 ? 'recreated' : 'created',
      webhookId: created.val.id,
    });
  }

  return ok({
    changed: registrations.some((registration) => registration.action !== 'kept'),
    registrations,
  });
}
