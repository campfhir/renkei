/**
 * Writing the voice ledger (migration 110): one row per call to the
 * speech service, after the vendor has answered, attributed to the
 * person who asked. Best-effort, like `recordLlmCall`: a ledger row that
 * could not be written is logged and the audio still reaches the person,
 * because a reply they cannot hear is worse than a count that is short.
 *
 * Content-free by construction — the text read and the words recognised
 * never come near this file; only how much of each.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '@/lib/logger';

export type VoiceUsageKind = 'speech' | 'transcription';

export interface RecordVoiceUsageInput {
  tenantId: string;
  subject: string;
  kind: VoiceUsageKind;
  /** Characters sent to be spoken (`speech`); 0 for a transcription. */
  characters?: number;
  /**
   * Milliseconds of audio: sent to be recognised (`transcription`), or
   * delivered to the person's speaker (`speech`) — the time they listened.
   */
  audioMs?: number;
  provider: string;
  voice?: string | null;
  locale?: string | null;
}

/** Bytes of a constant-bitrate encoding (MP3 at `kbps`) as milliseconds of sound. */
export function encodedDurationMs(byteLength: number, kbps: number): number {
  if (!(kbps > 0)) return 0;
  return Math.max(0, Math.round((byteLength * 8) / kbps));
}

/** The bytes of a 16 kHz, 16-bit, mono PCM WAV as milliseconds of sound. */
export function wavDurationMs(byteLength: number, sampleRate = 16_000): number {
  const header = 44;
  const bytesPerSecond = sampleRate * 2;
  return Math.max(0, Math.round(((byteLength - header) * 1000) / bytesPerSecond));
}

export async function recordVoiceUsage(
  db: Kysely<DB>,
  input: RecordVoiceUsageInput
): Promise<void> {
  try {
    await db
      .insertInto('voice_usage')
      .values({
        tenant_id: input.tenantId,
        subject: input.subject,
        kind: input.kind,
        characters: Math.max(0, Math.round(input.characters ?? 0)),
        audio_ms: Math.max(0, Math.round(input.audioMs ?? 0)),
        provider: input.provider.slice(0, 32),
        voice: input.voice ? input.voice.slice(0, 120) : null,
        locale: input.locale ? input.locale.slice(0, 16) : null,
      })
      .execute();
  } catch (error) {
    logger.warn('voice usage not recorded for tenant {tenantId}', {
      component: 'web/voice-usage',
      tenantId: input.tenantId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
