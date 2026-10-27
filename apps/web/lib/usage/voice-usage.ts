/**
 * Reading the voice ledger (migration 110) the way the usage pages read
 * the token ledger: totals over a span in the viewer's zone, org-wide or
 * for one person, and everyone's totals for the two leaderboards — who
 * listens the most (`speech`, by the second of audio delivered, with the
 * characters the vendor billed beside it), who talks to the chat the
 * most (`transcription`, by the second heard).
 */

import { getDataStore } from '@renkei/db';
import { spanWindow, type UsageSpan } from './user-utilization';
import type { VoiceUserRow } from './voice-window';

export interface VoiceTotals {
  /** Replies read aloud: text to speech — the characters billed, the audio delivered. */
  speech: { calls: number; characters: number; audioMs: number };
  /** The person's own voice recognised: speech to text. */
  transcription: { calls: number; audioMs: number };
}

export const ZERO_VOICE_TOTALS: VoiceTotals = {
  speech: { calls: 0, characters: 0, audioMs: 0 },
  transcription: { calls: 0, audioMs: 0 },
};

export async function getVoiceTotals(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<VoiceTotals> {
  const rows = await getDataStore().usageLedgers.voiceByKind({
    window: spanWindow(span, timeZone),
    subject: ownerSubject,
  });
  const speech = rows.find((row) => row.kind === 'speech');
  const transcription = rows.find((row) => row.kind === 'transcription');
  return {
    speech: {
      calls: speech?.calls ?? 0,
      characters: speech?.characters ?? 0,
      audioMs: speech?.audioMs ?? 0,
    },
    transcription: {
      calls: transcription?.calls ?? 0,
      audioMs: transcription?.audioMs ?? 0,
    },
  };
}

/** Everyone who used voice in the span, with both measures; unranked. */
export async function getVoiceUsers(span: UsageSpan, timeZone: string): Promise<VoiceUserRow[]> {
  const store = getDataStore();
  const [usage, identities] = await Promise.all([
    store.usageLedgers.voiceBySubjectKind({ window: spanWindow(span, timeZone) }),
    store.identities.list(),
  ]);
  const identityBySubject = new Map(identities.map((row) => [row.subject, row]));
  const bySubject = new Map<string, VoiceUserRow>();
  for (const row of usage) {
    const identity = identityBySubject.get(row.subject);
    const entry = bySubject.get(row.subject) ?? {
      subject: row.subject,
      label: identity?.displayName || identity?.email || row.subject,
      speechCharacters: 0,
      speechMs: 0,
      speechCalls: 0,
      transcriptionMs: 0,
      transcriptionCalls: 0,
    };
    if (row.kind === 'speech') {
      entry.speechCharacters += row.characters;
      entry.speechMs += row.audioMs;
      entry.speechCalls += row.calls;
    } else if (row.kind === 'transcription') {
      entry.transcriptionMs += row.audioMs;
      entry.transcriptionCalls += row.calls;
    }
    bySubject.set(row.subject, entry);
  }
  return [...bySubject.values()];
}
