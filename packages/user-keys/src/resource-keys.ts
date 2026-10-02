/**
 * The key store: one data key per resource, held at rest only wrapped
 * under the KEK of each person who may open it (migration 133).
 *
 * The shapes a caller needs:
 *   - create: a fresh key for a resource, wrapped for its owner;
 *   - open: the key as one person — their wrapping, their KEK;
 *   - share: unwrap as one person, wrap for another (the row that makes a
 *     shared chat readable to its grantee);
 *   - revoke / delete: forget one person's wrapping, or the key entirely.
 *
 * Nothing here decides WHO may share or open — `resource_access_grants`
 * and apps/web/lib/chat/access.ts do. This module only makes the bytes
 * follow those decisions.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { generateDataKey, unwrapKey, wrapKey } from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { ensureUserKek, getUserKek, type KekError, type UserKek } from './kek';

export type ResourceKeyKind = 'chat' | 'chat_project' | 'prompt_library';

/** A resource's data key, opened: what a cipher seals and opens with. */
export interface ResourceKey {
  id: string;
  key: Buffer;
}

export interface ResourceRef {
  tenantId: string;
  kind: ResourceKeyKind;
  resourceId: string;
}

export type OpenKeyError =
  | Exclude<KekError, 'NO_USER_KEY'>
  /** The resource has no key (a chat from before keys, not yet re-sealed). */
  | 'NO_KEY'
  /** The resource has a key, but not wrapped for this person. */
  | 'NO_ACCESS'
  | 'DECRYPTION_ERROR';

async function keyRow(db: Kysely<DB>, ref: ResourceRef): Promise<{ id: string } | null> {
  const row = await db
    .selectFrom('resource_keys')
    .select('id')
    .where('tenant_id', '=', ref.tenantId)
    .where('resource_kind', '=', ref.kind)
    .where('resource_id', '=', ref.resourceId)
    .executeTakeFirst();
  return row ?? null;
}

async function wrapFor(
  db: Kysely<DB>,
  tenantId: string,
  keyId: string,
  key: Buffer,
  subject: string,
  kek: UserKek,
  grantedBy: string | null
): Promise<void> {
  await db
    .insertInto('resource_key_grants')
    .values({
      resource_key_id: keyId,
      tenant_id: tenantId,
      subject,
      wrapped_key: wrapKey(key, kek.key),
      kek_version: kek.version,
      granted_by: grantedBy,
    })
    .onConflict((oc) =>
      oc.columns(['resource_key_id', 'subject']).doUpdateSet({
        wrapped_key: wrapKey(key, kek.key),
        kek_version: kek.version,
        granted_by: grantedBy,
      })
    )
    .execute();
}

/** Does the resource have a key at all? (Not whether anyone in particular may open it.) */
export async function hasResourceKey(db: Kysely<DB>, ref: ResourceRef): Promise<boolean> {
  return (await keyRow(db, ref)) !== null;
}

/**
 * Mint the resource's key and wrap it for its owner. If a key already
 * exists (two requests racing on a legacy chat's first write), the
 * existing one is opened for the owner instead — the owner always holds
 * a wrapping of the key that won.
 */
export async function createResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  ownerSubject: string
): Promise<Result<ResourceKey, OpenKeyError>> {
  const kek = await ensureUserKek(db, ref.tenantId, ownerSubject);
  if (!kek.ok) return kek;
  const key = generateDataKey();
  const inserted = await db
    .insertInto('resource_keys')
    .values({ tenant_id: ref.tenantId, resource_kind: ref.kind, resource_id: ref.resourceId })
    .onConflict((oc) => oc.columns(['resource_kind', 'resource_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return openResourceKey(db, ref, ownerSubject);
  await wrapFor(db, ref.tenantId, inserted.id, key, ownerSubject, kek.val, null);
  return ok({ id: inserted.id, key });
}

/** The resource's key as this person: their wrapping, opened under their KEK. */
export async function openResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  subject: string
): Promise<Result<ResourceKey, OpenKeyError>> {
  const row = await db
    .selectFrom('resource_keys as k')
    .leftJoin('resource_key_grants as g', (join) =>
      join.onRef('g.resource_key_id', '=', 'k.id').on('g.subject', '=', subject)
    )
    .select(['k.id', 'g.wrapped_key'])
    .where('k.tenant_id', '=', ref.tenantId)
    .where('k.resource_kind', '=', ref.kind)
    .where('k.resource_id', '=', ref.resourceId)
    .executeTakeFirst();
  if (!row) return err('NO_KEY' as const);
  if (row.wrapped_key === null) return err('NO_ACCESS' as const);
  const kek = await getUserKek(db, ref.tenantId, subject);
  if (!kek.ok) {
    // A wrapping exists for them, so their salt should too; a missing one
    // means it was shredded — unopenable, and that is the point.
    return err(kek.err.type === 'NO_USER_KEY' ? 'NO_ACCESS' : kek.err.type);
  }
  const key = unwrapKey(row.wrapped_key, kek.val.key);
  if (!key.ok) return err('DECRYPTION_ERROR' as const);
  return ok({ id: row.id, key: key.val });
}

/**
 * The key, as this person if they hold a wrapping and otherwise created
 * for them — the owner's path on a legacy resource's first keyed write.
 */
export async function ensureResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  ownerSubject: string
): Promise<Result<ResourceKey, OpenKeyError>> {
  const opened = await openResourceKey(db, ref, ownerSubject);
  if (opened.ok || opened.err.type !== 'NO_KEY') return opened;
  return createResourceKey(db, ref, ownerSubject);
}

/**
 * Many resources' keys at once, each as a named person: one KEK
 * derivation per distinct subject and one query for the wrappings. The
 * map holds only what opened; a caller decides what to do about the rest.
 */
export async function openResourceKeys(
  db: Kysely<DB>,
  tenantId: string,
  kind: ResourceKeyKind,
  entries: { resourceId: string; subject: string }[]
): Promise<Map<string, ResourceKey>> {
  const out = new Map<string, ResourceKey>();
  if (entries.length === 0) return out;
  const subjects = [...new Set(entries.map((entry) => entry.subject))];
  const rows = await db
    .selectFrom('resource_keys as k')
    .innerJoin('resource_key_grants as g', 'g.resource_key_id', 'k.id')
    .select(['k.id', 'k.resource_id', 'g.subject', 'g.wrapped_key'])
    .where('k.tenant_id', '=', tenantId)
    .where('k.resource_kind', '=', kind)
    .where(
      'k.resource_id',
      'in',
      entries.map((entry) => entry.resourceId)
    )
    .where('g.subject', 'in', subjects)
    .execute();
  const wanted = new Map(entries.map((entry) => [`${entry.resourceId}\0${entry.subject}`, entry]));
  const keks = new Map<string, UserKek>();
  for (const row of rows) {
    if (!wanted.has(`${row.resource_id}\0${row.subject}`)) continue;
    let kek = keks.get(row.subject);
    if (!kek) {
      const derived = await getUserKek(db, tenantId, row.subject);
      if (!derived.ok) continue;
      kek = derived.val;
      keks.set(row.subject, kek);
    }
    const key = unwrapKey(row.wrapped_key, kek.key);
    if (key.ok) out.set(row.resource_id, { id: row.id, key: key.val });
  }
  return out;
}

/**
 * Sharing: open the key as `fromSubject`, wrap it for `toSubject`. The
 * grantee's salt is created if this is the first key they hold. Nothing
 * is re-encrypted — the content stays under the one data key; only a new
 * wrapping of that key is written.
 */
export async function shareResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  fromSubject: string,
  toSubject: string
): Promise<Result<void, OpenKeyError>> {
  const opened = await openResourceKey(db, ref, fromSubject);
  if (!opened.ok) return opened;
  const kek = await ensureUserKek(db, ref.tenantId, toSubject);
  if (!kek.ok) return kek;
  await wrapFor(db, ref.tenantId, opened.val.id, opened.val.key, toSubject, kek.val, fromSubject);
  return ok();
}

/** Unsharing: forget this person's wrapping. The key itself and everyone else's stay. */
export async function revokeResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  subject: string
): Promise<boolean> {
  const row = await keyRow(db, ref);
  if (!row) return false;
  const result = await db
    .deleteFrom('resource_key_grants')
    .where('resource_key_id', '=', row.id)
    .where('subject', '=', subject)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/** The resource is gone: its key and every wrapping go with it (grants cascade). */
export async function deleteResourceKey(db: Kysely<DB>, ref: ResourceRef): Promise<void> {
  await db
    .deleteFrom('resource_keys')
    .where('tenant_id', '=', ref.tenantId)
    .where('resource_kind', '=', ref.kind)
    .where('resource_id', '=', ref.resourceId)
    .execute();
}

/** Who holds a wrapping of this resource's key — for the owner's view and for tests. */
export async function listResourceKeyHolders(
  db: Kysely<DB>,
  ref: ResourceRef
): Promise<{ subject: string; grantedBy: string | null; kekVersion: number }[]> {
  const row = await keyRow(db, ref);
  if (!row) return [];
  const rows = await db
    .selectFrom('resource_key_grants')
    .select(['subject', 'granted_by', 'kek_version'])
    .where('resource_key_id', '=', row.id)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((grant) => ({
    subject: grant.subject,
    grantedBy: grant.granted_by,
    kekVersion: grant.kek_version,
  }));
}

/**
 * Keys whose chat no longer exists — the sweep's half of "the app deletes
 * a resource's key with the resource" (chats are the only keyed kind so
 * far). Returns how many were removed.
 */
export async function pruneOrphanChatKeys(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ id: string }>`
    DELETE FROM resource_keys k
     WHERE k.resource_kind = 'chat'
       AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = k.resource_id)
    RETURNING k.id
  `.execute(db);
  return result.rows.length;
}
