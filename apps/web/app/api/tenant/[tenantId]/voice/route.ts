/**
 * What voice looks like for this person: whether the org has it, the org's
 * defaults, their own preferences, and the vendor's voice catalog (cached
 * an hour per org — see lib/voice/config.ts). The picker calls this when
 * it opens; the chat page learns availability server-side instead.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getVoicePrefs } from '@renkei/user-prefs';
import { getSessionFromRequest } from '@/lib/session';
import { listVoicesCached, resolveVoiceProvider } from '@/lib/voice/config';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const resolved = await resolveVoiceProvider(tenantId);
  if (!resolved) {
    return NextResponse.json({ configured: false, voices: [], prefs: null, defaults: null });
  }
  const [prefs, voices] = await Promise.all([
    getVoicePrefs(tenantId, session.subject, { fresh: true }),
    listVoicesCached(tenantId, resolved),
  ]);
  return NextResponse.json({
    configured: true,
    provider: resolved.provider.kind,
    defaults: { voice: resolved.config.defaultVoice, locale: resolved.config.defaultLocale },
    prefs,
    voices: voices.ok ? voices.val : [],
    voicesError: voices.ok ? null : voices.error.message,
  });
}
