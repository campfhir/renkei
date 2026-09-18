/**
 * Audio in, text out: one utterance of the person's speech, cut and
 * encoded in the browser (lib/voice/recorder.ts), recognised whole. Only
 * 16 kHz mono PCM WAV is accepted — the one encoding every vendor takes
 * and the browser can produce without a codec — and only as much of it as
 * a minute holds, which is more than any single utterance.
 *
 * Empty text is a normal answer (silence, a cough), not an error; the
 * voice mode simply keeps listening.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { normalizeLocale } from '@renkei/voice';
import { getSessionFromRequest } from '@/lib/session';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { resolveVoiceProvider } from '@/lib/voice/config';

/** 16 kHz × 16-bit × mono × 60 s, plus the header, rounded up. */
export const TRANSCRIBE_MAX_BYTES = 2 * 1024 * 1024;

const LIMITS = {
  perClient: { limit: 60, windowMs: 60_000 },
  global: { limit: 1_000, windowMs: 60_000 },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const verdict = checkInboundLimit(
    `voice/transcribe:${tenantId}:${session.subject}`,
    request,
    LIMITS
  );
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'Too many transcription requests; slow down a little.' },
      { status: 429, headers: { 'retry-after': String(verdict.retryAfterSeconds) } }
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^audio\/(wav|x-wav|wave)\b/i.test(contentType)) {
    return NextResponse.json({ error: 'Send 16 kHz mono PCM audio/wav.' }, { status: 415 });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > TRANSCRIBE_MAX_BYTES) {
    return NextResponse.json({ error: 'The recording is too long.' }, { status: 413 });
  }
  const audio = await request.arrayBuffer().catch(() => null);
  if (!audio || audio.byteLength === 0) {
    return NextResponse.json({ error: 'No audio received.' }, { status: 400 });
  }
  if (audio.byteLength > TRANSCRIBE_MAX_BYTES) {
    return NextResponse.json({ error: 'The recording is too long.' }, { status: 413 });
  }

  const resolved = await resolveVoiceProvider(tenantId);
  if (!resolved) {
    return NextResponse.json(
      { error: 'Voice is not configured for this organization.' },
      { status: 404 }
    );
  }
  const locale =
    normalizeLocale(request.nextUrl.searchParams.get('locale')) ?? resolved.config.defaultLocale;

  const result = await resolved.provider.transcribe({
    audio,
    contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
    locale,
    signal: request.signal,
  });
  if (!result.ok) {
    const status =
      result.error.kind === 'rate_limit' ? 429 : result.error.kind === 'timeout' ? 504 : 502;
    return NextResponse.json({ error: result.error.message, kind: result.error.kind }, { status });
  }
  return NextResponse.json({ text: result.val.text });
}
