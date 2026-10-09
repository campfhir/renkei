/**
 * What the browser needs to know about a person's encryption key
 * (docs/delegate-key-design.md): whether they have enrolled, what the
 * delegate holds for them right now, which delegate instances are alive
 * to seal to, and the wrapped keys the browser opens with the user key it
 * holds. Nothing here is a key: public keys, wrappings and dates only.
 *
 * Served by GET /api/tenant/[tenantId]/keys and rendered on the
 * preferences page; the KeyGuard decides from it what the browser must do.
 * The shape itself lives in shared.ts, which client code imports; this
 * module is server-only (it reads the database).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getDatabase } from '@renkei/db';
import { delegateClient } from '@renkei/delegate-client';
import type { Session } from '@/lib/session';

export {
  AUTOMATION_WINDOW_DAYS,
  AUTOMATION_WINDOW_DEFAULT_DAYS,
  type KeyStatusView,
} from './shared';
import {
  AUTOMATION_WINDOW_DAYS,
  AUTOMATION_WINDOW_DEFAULT_DAYS,
  type KeyStatusView,
} from './shared';

async function automationDaysOf(
  db: Kysely<DB>,
  subject: string
): Promise<number> {
  const row = await db
    .selectFrom('user_preferences')
    .select('value')
    .where('subject', '=', subject)
    .where('key', '=', 'encryption_key')
    .executeTakeFirst();
  const value = row?.value;
  if (typeof value === 'object' && value !== null && 'automationDays' in value) {
    const days = value.automationDays;
    if (typeof days === 'number' && AUTOMATION_WINDOW_DAYS.some((option) => option === days)) {
      return days;
    }
  }
  return AUTOMATION_WINDOW_DEFAULT_DAYS;
}

export async function setAutomationDays(
  db: Kysely<DB>,
  subject: string,
  days: number
): Promise<void> {
  await db
    .insertInto('user_preferences')
    .values({
      subject,
      key: 'encryption_key',
      value: JSON.stringify({ automationDays: days }),
    })
    .onConflict((oc) =>
      oc
        .columns(['subject', 'key'])
        .doUpdateSet({ value: JSON.stringify({ automationDays: days }) })
    )
    .execute();
}

/**
 * The asks still open for a person's key: when each was made and from what
 * browser, never the code — the approver types that off the asking screen
 * (app/api/tenant/[tenantId]/keys/devices).
 */
export async function pendingDevicesOf(
  db: Kysely<DB>,
  subject: string
): Promise<{ id: string; createdAt: string; userAgent: string | null }[]> {
  const rows = await db
    .selectFrom('device_key_requests')
    .select(['id', 'created_at', 'user_agent'])
    .where('subject', '=', subject)
    .where('sealed_key', 'is', null)
    .where('consumed_at', 'is', null)
    .where('denied_at', 'is', null)
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    userAgent: row.user_agent,
  }));
}

/** The status for the signed-in person, as of their session. */
export async function keyStatusView(
  session: Session
): Promise<KeyStatusView | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const db = dbResult.val;
  const client = delegateClient();
  const [status, instances, automationDays, pendingDevices] = await Promise.all([
    client.keyStatus(session.subject, session.id),
    client.keyInstancesSigned(),
    automationDaysOf(db, session.subject),
    pendingDevicesOf(db, session.subject),
  ]);
  if (!status.ok || !instances.ok) {
    return {
      enrolled: false,
      legacy: false,
      legacyNeedsPassphrase: false,
      publicKey: null,
      wrappedPrivateKey: null,
      wrappedAutomationKey: null,
      version: 0,
      enrolledAt: null,
      instances: [],
      instanceSigningKey: null,
      instancesSignature: null,
      sessionDelegated: false,
      instancesMissingSession: [],
      automationInstances: [],
      automationUntil: null,
      automationDays,
      pendingDevices,
      unavailable: true,
    };
  }
  const held = new Set(status.val.thisSessionInstances);
  const live = instances.val.instances;
  const missing = live.map((instance) => instance.id).filter((id) => !held.has(id));
  return {
    enrolled: status.val.enrolled,
    legacy: status.val.legacy,
    legacyNeedsPassphrase: status.val.legacyNeedsPassphrase,
    publicKey: status.val.publicKey,
    wrappedPrivateKey: status.val.wrappedPrivateKey,
    wrappedAutomationKey: status.val.wrappedAutomationKey,
    version: status.val.version,
    enrolledAt: status.val.enrolledAt ? status.val.enrolledAt.toISOString() : null,
    instances: live,
    instanceSigningKey: instances.val.signingKey,
    instancesSignature: instances.val.signature,
    sessionDelegated: live.length > 0 && missing.length === 0,
    instancesMissingSession: missing,
    automationInstances: status.val.automationInstances,
    automationUntil: status.val.automationUntil ? status.val.automationUntil.toISOString() : null,
    automationDays,
    pendingDevices,
    unavailable: false,
  };
}

/** The sealed delegations a request body carries, checked for shape only; the delegate checks the rest. */
export function sealedDelegationsOf(
  value: unknown
): { instanceId: string; sealedKey: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { instanceId: string; sealedKey: string }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(item));
    if (typeof record.instanceId !== 'string' || typeof record.sealedKey !== 'string') return null;
    if (!record.sealedKey.startsWith('sbox1:') || record.sealedKey.length > 4096) return null;
    out.push({ instanceId: record.instanceId, sealedKey: record.sealedKey });
  }
  return out;
}

/** A wrapped key or public key as the browser sends it: short base64-ish text, or nothing. */
export function keyMaterialOf(value: unknown, maxChars = 4096): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : null;
}

/** The automation window a body asks for, in days, within the allowed set. */
export function automationDaysOfBody(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return AUTOMATION_WINDOW_DAYS.find((days) => days === value) ?? null;
}
