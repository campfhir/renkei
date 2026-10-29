/**
 * "Test connection" for the voice form: lists the vendor's voices with the
 * stored configuration and reports how many came back — the one call that
 * proves the region, endpoint and key agree, without synthesising anything
 * or spending on a transcription.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { loadKeyring } from '@renkei/crypto';
import { getConnectorConfig } from '@renkei/connector-config';
import { VOICE_CONNECTOR, createVoiceProvider, parseVoiceConfig } from '@renkei/voice';
import { logger } from '@/lib/logger';

export async function POST(
  _request: NextRequest
): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error('Could not load the token encryption key: {error}', {
      component: 'api/admin/connectors/voice/test',
      subject: access.subject,
      error: keyResult.err.message ?? keyResult.err.type,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const configResult = await getConnectorConfig(VOICE_CONNECTOR, keyResult.val);
  if (!configResult.ok || !configResult.val) {
    return NextResponse.json({ error: 'Save the configuration first.' }, { status: 409 });
  }
  const config = parseVoiceConfig(configResult.val.settings, configResult.val.secrets);
  if (!config) {
    return NextResponse.json({ error: 'The configuration is incomplete.' }, { status: 409 });
  }
  const result = await createVoiceProvider(config).listVoices();
  if (!result.ok) {
    logger.warn('Voice connection test failed ({kind}): {error}', {
      component: 'api/admin/connectors/voice/test',
      subject: access.subject,
      kind: result.error.kind,
      error: result.error.message,
    });
    return NextResponse.json(
      { error: result.error.message, kind: result.error.kind },
      { status: 502 }
    );
  }
  const hasDefault = result.val.some((voice) => voice.id === config.defaultVoice);
  return NextResponse.json({
    ok: true,
    voices: result.val.length,
    locales: new Set(result.val.map((voice) => voice.locale)).size,
    defaultVoiceKnown: hasDefault,
  });
}
