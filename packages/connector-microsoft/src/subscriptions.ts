/**
 * Graph change-notification subscription lifecycle.
 *
 * Subscriptions are how Graph pushes "something changed" at Renkei so delta
 * rounds run on events instead of polls. They expire aggressively and by
 * design: every resource type has its own ceiling (mail ~10,070 minutes,
 * calendar/todo ~4,230), so a uniform lifetime under the lowest ceiling keeps
 * renewal logic identical across resources instead of encoding a per-resource
 * table that drifts against Microsoft's documentation.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { graphRequest } from './client';

/** Uniform subscription lifetime: ~2.9 days, safely under every resource's ceiling. */
export const GRAPH_SUBSCRIPTION_MINUTES = 4200;

export interface CreateSubscriptionOptions {
  /** e.g. "/me/mailFolders('inbox')/messages" — what to watch. */
  resource: string;
  /** e.g. 'created,updated,deleted'. */
  changeType: string;
  /** Where Graph POSTs change notifications (must answer the validation handshake). */
  notificationUrl: string;
  /** Where Graph POSTs lifecycle events (reauthorizationRequired, missed, removed). */
  lifecycleNotificationUrl: string;
  /** Echoed back on every notification — how receipt is authenticated. */
  clientState: string;
  expirationMinutes?: number;
}

export interface GraphSubscription {
  id: string;
  resource: string;
  expirationDateTime: string;
  clientState?: string;
  /**
   * Where Graph delivers it. Load-bearing for reconciliation: one Entra app
   * registration is commonly shared by several deployments, so "not in my
   * table" is NOT sufficient grounds to delete a subscription — it might be
   * another environment's. The notificationUrl is what says whose it is.
   */
  notificationUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expirationFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export async function createGraphSubscription(
  accessToken: string,
  opts: CreateSubscriptionOptions
): Promise<Result<{ id: string; expiresAt: Date }, 'GRAPH_API_ERROR'>> {
  const result = await graphRequest(accessToken, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      resource: opts.resource,
      changeType: opts.changeType,
      notificationUrl: opts.notificationUrl,
      lifecycleNotificationUrl: opts.lifecycleNotificationUrl,
      clientState: opts.clientState,
      expirationDateTime: expirationFromNow(opts.expirationMinutes ?? GRAPH_SUBSCRIPTION_MINUTES),
    }),
  });
  if (!result.ok) return result;

  const body = result.val;
  if (
    !isRecord(body) ||
    typeof body.id !== 'string' ||
    typeof body.expirationDateTime !== 'string'
  ) {
    return err('GRAPH_API_ERROR' as const, {
      message: 'subscription response missing id or expirationDateTime',
    });
  }
  return ok({ id: body.id, expiresAt: new Date(body.expirationDateTime) });
}

export async function renewGraphSubscription(
  accessToken: string,
  subscriptionId: string,
  expirationMinutes?: number
): Promise<Result<{ expiresAt: Date }, 'GRAPH_API_ERROR'>> {
  const result = await graphRequest(
    accessToken,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        expirationDateTime: expirationFromNow(expirationMinutes ?? GRAPH_SUBSCRIPTION_MINUTES),
      }),
    }
  );
  if (!result.ok) return result;

  const body = result.val;
  if (!isRecord(body) || typeof body.expirationDateTime !== 'string') {
    return err('GRAPH_API_ERROR' as const, {
      message: 'subscription renewal response missing expirationDateTime',
    });
  }
  return ok({ expiresAt: new Date(body.expirationDateTime) });
}

export async function deleteGraphSubscription(
  accessToken: string,
  subscriptionId: string
): Promise<Result<void, 'GRAPH_API_ERROR'>> {
  const result = await graphRequest(
    accessToken,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'DELETE' }
  );
  // A 404 means the subscription is already gone — Graph reaps expired ones
  // itself, so "not found" is the desired end state, not a failure.
  if (!result.ok) {
    if (result.err.cause === 404) return ok();
    return result;
  }
  return ok();
}

export async function listGraphSubscriptions(
  accessToken: string
): Promise<Result<GraphSubscription[], 'GRAPH_API_ERROR'>> {
  const result = await graphRequest(accessToken, '/subscriptions');
  if (!result.ok) return result;

  const body = result.val;
  const items = isRecord(body) ? body.value : null;
  if (!Array.isArray(items)) {
    return err('GRAPH_API_ERROR' as const, { message: 'subscriptions response missing value[]' });
  }

  const subscriptions: GraphSubscription[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== 'string') continue;
    subscriptions.push({
      id: item.id,
      resource: typeof item.resource === 'string' ? item.resource : '',
      expirationDateTime:
        typeof item.expirationDateTime === 'string' ? item.expirationDateTime : '',
      ...(typeof item.clientState === 'string' ? { clientState: item.clientState } : {}),
      ...(typeof item.notificationUrl === 'string'
        ? { notificationUrl: item.notificationUrl }
        : {}),
    });
  }
  return ok(subscriptions);
}
