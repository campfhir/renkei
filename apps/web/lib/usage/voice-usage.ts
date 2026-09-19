/**
 * Reading the voice ledger (migration 110) the way the usage pages read
 * the token ledger: totals over a span in the viewer's zone, org-wide or
 * for one person, and everyone's totals for the two leaderboards — who
 * listens the most (`speech`, by the second of audio delivered, with the
 * characters the vendor billed beside it), who talks to the chat the
 * most (`transcription`, by the second heard).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { inSpan, type UsageSpan } from './user-utilization';
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

interface KindRow {
  kind: string;
  calls: string;
  characters: string;
  audio_ms: string;
}

function ownedBy(ownerSubject: string | null) {
  return ownerSubject === null ? sql`` : sql`AND subject = ${ownerSubject}`;
}

export async function getVoiceTotals(
  db: Kysely<DB>,
  tenantId: string,
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<VoiceTotals> {
  const result = await sql<KindRow>`
    SELECT kind, COUNT(*) AS calls,
           COALESCE(SUM(characters), 0) AS characters,
           COALESCE(SUM(audio_ms), 0) AS audio_ms
    FROM voice_usage
    WHERE tenant_id = ${tenantId} AND ${inSpan('created_at', span, timeZone)}
      ${ownedBy(ownerSubject)}
    GROUP BY kind
  `.execute(db);
  const speech = result.rows.find((row) => row.kind === 'speech');
  const transcription = result.rows.find((row) => row.kind === 'transcription');
  return {
    speech: {
      calls: Number(speech?.calls ?? 0),
      characters: Number(speech?.characters ?? 0),
      audioMs: Number(speech?.audio_ms ?? 0),
    },
    transcription: {
      calls: Number(transcription?.calls ?? 0),
      audioMs: Number(transcription?.audio_ms ?? 0),
    },
  };
}

/** Everyone who used voice in the span, with both measures; unranked. */
export async function getVoiceUsers(
  db: Kysely<DB>,
  tenantId: string,
  span: UsageSpan,
  timeZone: string
): Promise<VoiceUserRow[]> {
  const [usage, identities] = await Promise.all([
    sql<KindRow & { subject: string }>`
      SELECT subject, kind, COUNT(*) AS calls,
             COALESCE(SUM(characters), 0) AS characters,
             COALESCE(SUM(audio_ms), 0) AS audio_ms
      FROM voice_usage
      WHERE tenant_id = ${tenantId} AND ${inSpan('created_at', span, timeZone)}
      GROUP BY subject, kind
    `.execute(db),
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email'])
      .where('tenant_id', '=', tenantId)
      .execute(),
  ]);
  const identityBySubject = new Map(identities.map((row) => [row.subject, row]));
  const bySubject = new Map<string, VoiceUserRow>();
  for (const row of usage.rows) {
    const identity = identityBySubject.get(row.subject);
    const entry = bySubject.get(row.subject) ?? {
      subject: row.subject,
      label: identity?.display_name || identity?.email || row.subject,
      speechCharacters: 0,
      speechMs: 0,
      speechCalls: 0,
      transcriptionMs: 0,
      transcriptionCalls: 0,
    };
    if (row.kind === 'speech') {
      entry.speechCharacters += Number(row.characters);
      entry.speechMs += Number(row.audio_ms);
      entry.speechCalls += Number(row.calls);
    } else if (row.kind === 'transcription') {
      entry.transcriptionMs += Number(row.audio_ms);
      entry.transcriptionCalls += Number(row.calls);
    }
    bySubject.set(row.subject, entry);
  }
  return [...bySubject.values()];
}
