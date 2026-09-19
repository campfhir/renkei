/**
 * Text in, audio out. The browser sends one sentence or paragraph at a time
 * (lib/voice/speech-queue.ts cuts a reply as it streams) and plays what
 * comes back in order, so this stays a short, cacheable-nowhere call: no
 * store, streamed straight through from the vendor.
 *
 * Bounded per person and per org (inbound-rate-limit), because every call
 * is billed by the vendor and a runaway page must not be able to spend
 * without limit. The text itself is capped well under any vendor ceiling;
 * the client splits longer replies before asking.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { clampRate, normalizeLocale } from '@renkei/voice';
import { getSessionFromRequest } from '@/lib/session';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { resolveVoiceProvider } from '@/lib/voice/config';
import { recordVoiceUsage } from '@/lib/voice/usage';

/** A vendor ceiling is far higher; this keeps one request to one breath of audio. */
export const SPEECH_MAX_CHARS = 3_000;

const LIMITS = {
  perClient: { limit: 120, windowMs: 60_000 },
  global: { limit: 2_000, windowMs: 60_000 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const verdict = checkInboundLimit(`voice/speech:${tenantId}:${session.subject}`, request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'Too many speech requests; slow down a little.' },
      { status: 429, headers: { 'retry-after': String(verdict.retryAfterSeconds) } }
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return NextResponse.json({ error: 'Nothing to say' }, { status: 400 });
  if (text.length > SPEECH_MAX_CHARS) {
    return NextResponse.json(
      { error: `Speech requests are limited to ${SPEECH_MAX_CHARS} characters.` },
      { status: 413 }
    );
  }

  const resolved = await resolveVoiceProvider(tenantId);
  if (!resolved) {
    return NextResponse.json(
      { error: 'Voice is not configured for this organization.' },
      { status: 404 }
    );
  }
  const voice =
    typeof body.voice === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(body.voice) ? body.voice : null;
  const locale = normalizeLocale(body.locale) ?? resolved.config.defaultLocale;

  const result = await resolved.provider.synthesize({
    text,
    voice,
    rate: clampRate(body.rate),
    locale,
    signal: request.signal,
  });
  if (!result.ok) {
    const status =
      result.error.kind === 'rate_limit' ? 429 : result.error.kind === 'timeout' ? 504 : 502;
    return NextResponse.json({ error: result.error.message, kind: result.error.kind }, { status });
  }
  // The ledger row (migration 110): characters, never the text.
  const dbResult = getDatabase();
  if (dbResult.ok) {
    void recordVoiceUsage(dbResult.val, {
      tenantId,
      subject: session.subject,
      kind: 'speech',
      characters: text.length,
      provider: resolved.provider.kind,
      voice: voice ?? resolved.config.defaultVoice,
      locale,
    });
  }
  return new Response(result.val.body, {
    status: 200,
    headers: {
      'content-type': result.val.contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
