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
    logger.error('Could not resolve the app origin: {error}', {
      component: 'webex/all-spaces',
      subject: session.subject,
      error: originResult.err.message ?? originResult.err.type,
    });
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
      logger.warn('all-spaces webhook registration failed', {
        component: 'webex/all-spaces',
      });
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
      logger.warn('WebEx rejected the webhook removal — try again: {error}', {
        component: 'webex/all-spaces',
        subject: session.subject,
        error: deleted.err.message ?? deleted.err.type,
      });
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
