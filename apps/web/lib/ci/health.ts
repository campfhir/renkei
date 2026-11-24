/**
 * Health check-ins, on the server (health-rules.ts holds the interface and
 * how lateness is read): issuing an environment's token, taking it away,
 * and recording a check-in made with one.
 *
 * A token is shown once, when it is issued, and kept only as its SHA-256
 * hash: Renkei cannot show it again, and a stolen row is not a token. It
 * names one environment of one project and can do one thing — say how that
 * environment's application is.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getDataStore, type CiHealthRecord } from '@renkei/db';
import { HEALTH_PATH, readCheckin, type HealthView } from './health-rules';

const TOKEN_PREFIX = 'rkh_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function healthView(record: CiHealthRecord): HealthView {
  return {
    tokenHint: record.tokenHint,
    issuedAt: record.issuedAt.toISOString(),
    status: record.status,
    message: record.message,
    version: record.version,
    sentAt: record.sentAt?.toISOString() ?? null,
    receivedAt: record.receivedAt?.toISOString() ?? null,
    intervalSeconds: record.intervalSeconds,
    checkins: record.checkins,
  };
}

/** Where an application checks in: this Renkei's address and the path; null when the address is unknown. */
export function checkInUrl(origin: string): string | null {
  const base = origin.replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+$/.test(base) ? `${base}${HEALTH_PATH}` : null;
}

/** Issue the environment's token, in place of any it had; the token is answered once and not kept. */
export async function issueHealthToken(
  projectId: string,
  environment: string,
  subject: string,
  now: Date
): Promise<{ token: string; hint: string }> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const hint = token.slice(-4);
  await getDataStore().ciHealth.issueToken(projectId, environment, {
    hash: hashToken(token),
    hint,
    issuedBy: subject,
    at: now,
  });
  return { token, hint };
}

export function revokeHealthToken(projectId: string, environment: string): Promise<boolean> {
  return getDataStore().ciHealth.revoke(projectId, environment);
}

export type CheckInOutcome =
  { ok: true; record: CiHealthRecord } | { ok: false; status: number; error: string };

/** A check-in as it arrived: the bearer token names the environment, the body says how it is. */
export async function recordCheckIn(input: {
  authorization: string | null;
  body: unknown;
  now: Date;
}): Promise<CheckInOutcome> {
  const token = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? '')?.[1];
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return {
      ok: false,
      status: 401,
      error: 'Send the environment’s health token as a bearer token.',
    };
  }
  const read = readCheckin(input.body, input.now);
  if (!read.ok) return { ok: false, status: 400, error: read.error };
  const record = await getDataStore().ciHealth.checkIn(hashToken(token), {
    status: read.checkin.status,
    message: read.checkin.message,
    version: read.checkin.version,
    sentAt: read.checkin.sentAt,
    receivedAt: input.now,
    intervalSeconds: read.checkin.intervalSeconds,
  });
  if (!record) {
    return {
      ok: false,
      status: 401,
      error: 'That health token is not one Renkei issued, or it was replaced.',
    };
  }
  return { ok: true, record };
}
