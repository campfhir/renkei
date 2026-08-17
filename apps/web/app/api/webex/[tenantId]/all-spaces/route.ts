/**
 * Opt in/out of the all-spaces webhook: a no-roomId-filter messages
 * webhook on the CALLER's own WebEx token, firing for every space they
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
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const payload: { enabled?: unknown } = typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });

  const access = await resolveWebexUserAccess(tenantId, session.subject);
  if (!access) {
    return NextResponse.json({ error: 'Connect WebEx first' }, { status: 409 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const targetUrl = webexUserWebhookTargetUrl(originResult.val, tenantId, access.accountId);
  const client = new WebexClient(access.accessToken);

  const existingSecret =
    typeof access.metadata.allSpacesSecret === 'string' ? access.metadata.allSpacesSecret : null;

  if (payload.enabled) {
    const secret = existingSecret ?? generateSecret();
    const ensured = await ensureWebexWebhooks(client, { targetUrl, secret });
    if (!ensured.ok) {
      logger.warn('all-spaces webhook registration failed', {
        component: 'webex/all-spaces',
        tenantId,
      });
      return NextResponse.json(
        { error: 'WebEx rejected the webhook registration — try again.' },
        { status: 502 }
      );
    }
    await dbResult.val
      .updateTable('provider_grants')
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          allSpaces: true,
          allSpacesSecret: secret,
        })}::jsonb`,
      })
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', 'webex')
      .where('provider_account_id', '=', access.accountId)
      .execute();
  } else {
    const deleted = await deleteWebexWebhooksFor(client, targetUrl);
    if (!deleted.ok) {
      return NextResponse.json(
        { error: 'WebEx rejected the webhook removal — try again.' },
        { status: 502 }
      );
    }
    await dbResult.val
      .updateTable('provider_grants')
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ allSpaces: false })}::jsonb`,
      })
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', 'webex')
      .where('provider_account_id', '=', access.accountId)
      .execute();
  }

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: payload.enabled ? 'connector.connected' : 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: 'webex',
    details: { allSpacesWebhook: payload.enabled },
  });
  return NextResponse.json({ allSpaces: payload.enabled });
}
