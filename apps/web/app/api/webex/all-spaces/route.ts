/**
 * Opt in/out of the all-spaces webhook: a no-roomId-filter messages
 * webhook on the CALLER's own WebEx grant, firing for every space they
 * are in (including ones they join later) and feeding only their own
 * agent triggers. Strictly self-service — the session decides whose
 * webhook, never a parameter — and reversible: opting out deletes the
 * registration.
 *
 * The signing secret is per-grant, minted here and stored in the grant's
 * metadata; the per-user receipt route verifies against it. Nothing
 * depends on any org-level bot configuration — there is none anymore.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { WEBEX_USER } from '@renkei/provider-grants';
import { generateSecret } from '@renkei/crypto';
import {
  WebexClient,
  ensureWebexWebhooks,
  deleteWebexWebhooksFor,
  webexUserWebhookTargetUrl,
} from '@renkei/connector-webex';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const payload: { enabled?: unknown } = typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 });
  }

  const access = await resolveWebexUserAccess(session.subject);
  if (!access) {
    return NextResponse.json({ error: 'Connect WebEx first' }, { status: 409 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    logger.error(
      '{actor} asked to turn the WebEx all-spaces webhook {onOff}, but the app origin could not be resolved; nothing was changed: {error}',
      {
        component: 'webex/all-spaces',
        ...who(session),
        accountId: access.accountId,
        onOff: payload.enabled ? 'on' : 'off',
        error: originResult.err.message ?? originResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const targetUrl = webexUserWebhookTargetUrl(originResult.val, access.accountId);
  const client = new WebexClient(access.auth);

  const existingSecret =
    typeof access.metadata.allSpacesSecret === 'string' ? access.metadata.allSpacesSecret : null;

  if (payload.enabled) {
    const secret = existingSecret ?? generateSecret();
    const ensured = await ensureWebexWebhooks(client, { targetUrl, secret });
    if (!ensured.ok) {
      logger.warn(
        '{actor} asked to turn the WebEx all-spaces webhook on, but WebEx rejected the registration; it stays off and the person was asked to try again',
        {
          component: 'webex/all-spaces',
          ...who(session),
          accountId: access.accountId,
        }
      );
      return NextResponse.json(
        { error: 'WebEx rejected the webhook registration — try again.' },
        { status: 502 }
      );
    }
    await getDataStore().providerGrants.mergeMetadata(WEBEX_USER, access.accountId, {
      allSpaces: true,
      allSpacesSecret: secret,
    });
  } else {
    const deleted = await deleteWebexWebhooksFor(client, targetUrl);
    if (!deleted.ok) {
      logger.warn(
        '{actor} asked to turn the WebEx all-spaces webhook off, but WebEx rejected the removal; it stays registered and the person was asked to try again: {error}',
        {
          component: 'webex/all-spaces',
          ...who(session),
          accountId: access.accountId,
          error: deleted.err.message ?? deleted.err.type,
        }
      );
      return NextResponse.json(
        { error: 'WebEx rejected the webhook removal — try again.' },
        { status: 502 }
      );
    }
    await getDataStore().providerGrants.mergeMetadata(WEBEX_USER, access.accountId, {
      allSpaces: false,
    });
  }

  recordAuditEvent({
    actorSubject: session.subject,
    action: payload.enabled ? 'connector.connected' : 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: 'webex',
    details: { allSpacesWebhook: payload.enabled },
  });
  return NextResponse.json({ allSpaces: payload.enabled });
}
