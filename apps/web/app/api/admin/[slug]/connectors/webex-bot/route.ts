/**
 * Org-admin configuration of the WebEx bot — the one that leaves people
 * notes so they arrive unread (see lib/webex-bot.ts). GET reports presence
 * only; the token never leaves the server. PUT with a new token proves it
 * against WebEx first (GET /people/me) and records who the bot is, so the
 * form can show "Renkei (renkei@webex.bot)" instead of a stored secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { WebexClient } from '@renkei/connector-webex';
import { WEBEX_BOT_CONNECTOR } from '@/lib/webex-bot';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(tenantRef.id, WEBEX_BOT_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: WEBEX_BOT_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    displayName:
      typeof config?.settings.displayName === 'string' ? config.settings.displayName : null,
    email: typeof config?.settings.email === 'string' ? config.settings.email : null,
    hasBotToken: Boolean(config?.secrets.botToken),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : '';

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // The token survives an enable/disable save: a blank field keeps the
  // stored one, and the identity recorded with it. A token is required
  // only when none is stored yet.
  const existing = await getConnectorConfig(tenantRef.id, WEBEX_BOT_CONNECTOR, keyResult.val);
  const stored = existing.ok ? existing.val : null;
  let token = stored?.secrets.botToken ?? '';
  let settings: Record<string, unknown> = stored?.settings ?? {};

  if (botToken) {
    // Proven before it is stored: a pasted Integration secret, a personal
    // token or a typo would otherwise sit there failing every note quietly.
    const me = await new WebexClient(botToken, { lane: 'interactive' }).getMe();
    if (!me.ok) {
      return NextResponse.json(
        {
          error:
            'WebEx did not accept that token. Paste the bot’s access token from developer.webex.com → My Apps.',
        },
        { status: 400 }
      );
    }
    token = botToken;
    settings = {
      displayName: me.val.displayName,
      email: me.val.emails[0] ?? null,
      personId: me.val.id,
    };
  }
  if (!token) {
    return NextResponse.json({ error: 'botToken is required (none stored yet)' }, { status: 400 });
  }

  const writeResult = await setConnectorConfig(
    tenantRef.id,
    WEBEX_BOT_CONNECTOR,
    { enabled, settings, secrets: { botToken: token } },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantRef.id, WEBEX_BOT_CONNECTOR);
  return NextResponse.json({
    connector: WEBEX_BOT_CONNECTOR,
    configured: true,
    enabled,
    displayName: typeof settings.displayName === 'string' ? settings.displayName : null,
    email: typeof settings.email === 'string' ? settings.email : null,
  });
}
