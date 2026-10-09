/**
 * The key store: one data key per resource, held at rest only wrapped
 * (migrations 133, 138). What a wrapping is under is its `holder_kind`:
 *
 *   user        the person's user key — their own chats and projects;
 *   automation  the person's automation key — what their agents may open
 *               while they are away: the chats agents write into;
 *   public      a sealed box to the person's X25519 public key — the form
 *               a SHARE writes, since the grantee need not be present;
 *               converted to a `user` wrapping the first time they open it;
 *   resource    another resource's key — a chat's key under its project's,
 *               so every member of the project opens it.
 *
 * The shapes a caller needs:
 *   - create / ensure: a fresh key for a resource, wrapped for its owner;
 *   - open: the key as one person, through whichever wrapping their keys
 *     reach; `open-many` for a sidebar's worth;
 *   - share: wrap to a grantee's public key; wrapUnder: to a parent key;
 *   - grantAutomation: let the person's agents at a resource;
 *   - revoke / delete: forget one person's wrappings, or the key entirely.
 *
 * Nothing here decides WHO may share or open — `resource_access_grants`
 * and apps/web/lib/chat/access.ts do. This module only makes the bytes
 * follow those decisions, and it never derives a key: every open goes
 * through the person's ring (keyring.ts).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  generateDataKey,
  openSealedBox,
  sealToPublicKey,
  unwrapKey,
  wrapKey,
} from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getKeyRing, readKeyRow, type KeyError, type KeyRing } from './keyring';

export type ResourceKeyKind = 'chat' | 'chat_project' | 'prompt_library';
export type HolderKind = 'user' | 'automation' | 'public' | 'resource';

/** A resource's data key, opened: what a cipher seals and opens with. */
export interface ResourceKey {
  id: string;
  key: Buffer;
}

export interface ResourceRef {
  kind: ResourceKeyKind;
  resourceId: string;
}

export type OpenKeyError =
  | Exclude<KeyError, 'NO_USER_KEY'>
  /** The resource has no key (a chat from before keys, not yet re-sealed). */
  | 'NO_KEY'
  /** The resource has a key, but none of this person's keys reach a wrapping of it. */
  | 'NO_ACCESS';

export type ShareKeyError =
  | OpenKeyError
  /** The grantee has not enrolled: there is no public key to wrap to yet. */
  | 'GRANTEE_NOT_ENROLLED';

interface GrantRow {
  resource_key_id: string;
  holder_kind: string;
  holder: string;
  wrapped_key: string;
}

/** How deep a chain of `resource` wrappings is followed: a chat under its project, no further. */
const MAX_PARENT_DEPTH = 1;

async function keyRow(db: Kysely<DB>, ref: ResourceRef): Promise<{ id: string } | null> {
  const row = await db
    .selectFrom('resource_keys')
    .select('id')
    .where('resource_kind', '=', ref.kind)
    .where('resource_id', '=', ref.resourceId)
    .executeTakeFirst();
  return row ?? null;
}

async function grantRows(db: Kysely<DB>, keyIds: string[]): Promise<GrantRow[]> {
  if (keyIds.length === 0) return [];
  return db
    .selectFrom('resource_key_grants')
    .select(['resource_key_id', 'holder_kind', 'holder', 'wrapped_key'])
    .where('resource_key_id', 'in', keyIds)
    .execute();
}

async function upsertWrapping(
  db: Kysely<DB>,
  tenantId: string,
  keyId: string,
  holderKind: HolderKind,
  holder: string,
  wrapped: string,
  version: number,
  grantedBy: string | null
): Promise<void> {
  await db
    .insertInto('resource_key_grants')
    .values({
      resource_key_id: keyId,
      holder_kind: holderKind,
      holder,
      wrapped_key: wrapped,
      kek_version: version,
      granted_by: grantedBy,
    })
    .onConflict((oc) =>
      oc
        .columns(['resource_key_id', 'holder_kind', 'holder'])
        .doUpdateSet({ wrapped_key: wrapped, kek_version: version, granted_by: grantedBy })
    )
    .execute();
}

/**
 * One key's wrappings against one ring, no database: the user wrapping
 * (session), the automation wrapping (either), the public wrapping
 * (session, through the private key). `needsSession` says a wrapping
 * exists that only the person's presence would open.
 */
function openDirect(
  rows: GrantRow[],
  ring: KeyRing
): { key: Buffer; via: HolderKind } | { key: null; needsSession: boolean } {
  let needsSession = false;
  for (const row of rows) {
    if (row.holder !== ring.subject) continue;
    if (row.holder_kind === 'user') {
      if (!ring.userKey) {
        needsSession = true;
        continue;
      }
      const key = unwrapKey(row.wrapped_key, ring.userKey);
      if (key.ok) return { key: key.val, via: 'user' };
    } else if (row.holder_kind === 'automation') {
      const key = unwrapKey(row.wrapped_key, ring.automationKey);
      if (key.ok) return { key: key.val, via: 'automation' };
    } else if (row.holder_kind === 'public') {
      const privateKey = ring.privateKey();
      if (!privateKey) {
        needsSession = true;
        continue;
      }
      const opened = openSealedBox({ publicKey: ring.publicKey, privateKey }, row.wrapped_key);
      if (opened.ok && opened.val.byteLength === 32) return { key: opened.val, via: 'public' };
    }
  }
  return { key: null, needsSession };
}

/**
 * A key opened through its parent: for each `resource` wrapping, open the
 * parent key as this person and unwrap under it.
 */
async function openThroughParents(
  db: Kysely<DB>,
  rows: GrantRow[],
  ring: KeyRing,
  depth: number
): Promise<Result<Buffer, OpenKeyError> | null> {
  if (depth > MAX_PARENT_DEPTH) return null;
  let needsSession = false;
  for (const row of rows) {
    if (row.holder_kind !== 'resource') continue;
    const parent = await openKeyById(db, row.holder, ring, depth + 1);
    if (parent.ok) {
      const key = unwrapKey(row.wrapped_key, parent.val);
      if (key.ok) return ok(key.val);
    } else if (parent.err.type === 'NEEDS_SESSION') {
      needsSession = true;
    }
  }
  return needsSession ? err('NEEDS_SESSION' as const) : null;
}

/** A public wrapping just opened becomes a user wrapping, so the next open is a plain unwrap. */
async function convertPublicWrapping(
  db: Kysely<DB>,
  tenantId: string,
  keyId: string,
  ring: KeyRing,
  key: Buffer
): Promise<void> {
  if (!ring.userKey) return;
  await upsertWrapping(
    db,
    keyId,
    'user',
    ring.subject,
    wrapKey(key, ring.userKey),
    ring.version,
    null
  );
  await db
    .deleteFrom('resource_key_grants')
    .where('resource_key_id', '=', keyId)
    .where('holder_kind', '=', 'public')
    .where('holder', '=', ring.subject)
    .execute();
}

async function openKeyById(
  db: Kysely<DB>,
  keyId: string,
  ring: KeyRing,
  depth: number
): Promise<Result<Buffer, OpenKeyError>> {
  const rows = await grantRows(db, [keyId]);
  const direct = openDirect(rows, ring);
  if (direct.key) {
    if (direct.via === 'public')
      await convertPublicWrapping(db, ring.tenantId, keyId, ring, direct.key);
    return ok(direct.key);
  }
  const viaParent = await openThroughParents(db, rows, ring, depth);
  if (viaParent) return viaParent;
  return err(direct.needsSession ? ('NEEDS_SESSION' as const) : ('NO_ACCESS' as const));
}

function ringError(error: KeyError): OpenKeyError {
  // A person with no key row holds no wrapping: to them the resource is simply closed.
  return error === 'NO_USER_KEY' ? 'NO_ACCESS' : error;
}

/** Does the resource have a key at all? (Not whether anyone in particular may open it.) */
export async function hasResourceKey(db: Kysely<DB>, ref: ResourceRef): Promise<boolean> {
  return (await keyRow(db, ref)) !== null;
}

/** The resource's key as this person: through whichever of their wrappings their keys reach. */
export async function openResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  subject: string
): Promise<Result<ResourceKey, OpenKeyError>> {
  const row = await keyRow(db, ref);
  if (!row) return err('NO_KEY' as const);
  const ring = await getKeyRing(db, ref.tenantId, subject);
  if (!ring.ok) return err(ringError(ring.err.type));
  const key = await openKeyById(db, row.id, ring.val, 0);
  return key.ok ? ok({ id: row.id, key: key.val }) : key;
}

export interface CreateKeyOptions {
  /** Also wrap under the owner's automation key: their agents may open it unattended. */
  automation?: boolean;
}

/**
 * Mint the resource's key and wrap it for its owner — under their user
 * key when the person is present, under their automation key when only
 * their agents are (a chat an agent opens for them), and under both when
 * asked. If a key already exists (two requests racing on a legacy
 * resource's first write), the existing one is opened for the owner
 * instead — the owner always holds a wrapping of the key that won.
 */
export async function createResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  ownerSubject: string,
  options: CreateKeyOptions = {}
): Promise<Result<ResourceKey, OpenKeyError>> {
  const ring = await getKeyRing(db, ref.tenantId, ownerSubject);
  if (!ring.ok) return err(ringError(ring.err.type));
  const key = generateDataKey();
  const inserted = await db
    .insertInto('resource_keys')
    .values({ resource_kind: ref.kind, resource_id: ref.resourceId })
    .onConflict((oc) => oc.columns(['resource_kind', 'resource_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return openResourceKey(db, ref, ownerSubject);
  await wrapForRing(db, ref.tenantId, inserted.id, key, ring.val, options.automation === true);
  return ok({ id: inserted.id, key });
}

async function wrapForRing(
  db: Kysely<DB>,
  tenantId: string,
  keyId: string,
  key: Buffer,
  ring: KeyRing,
  automation: boolean
): Promise<void> {
  if (ring.userKey) {
    await upsertWrapping(
      db,
      keyId,
      'user',
      ring.subject,
      wrapKey(key, ring.userKey),
      ring.version,
      null
    );
  }
  if (automation || !ring.userKey) {
    await upsertWrapping(
      db,
      keyId,
      'automation',
      ring.subject,
      wrapKey(key, ring.automationKey),
      ring.version,
      null
    );
  }
}

/**
 * The key, as this person if they hold a wrapping and otherwise created
 * for them — the owner's path on a legacy resource's first keyed write.
 */
export async function ensureResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  ownerSubject: string,
  options: CreateKeyOptions = {}
): Promise<Result<ResourceKey, OpenKeyError>> {
  const opened = await openResourceKey(db, ref, ownerSubject);
  if (opened.ok || opened.err.type !== 'NO_KEY') return opened;
  return createResourceKey(db, ref, ownerSubject, options);
}

/**
 * Let the person's agents at the resource: a wrapping under their
 * automation key beside whatever they already hold. Needs the key to open
 * for them now (either scope: the automation key is in both rings).
 */
export async function grantAutomationAccess(
  db: Kysely<DB>,
  ref: ResourceRef,
  subject: string
): Promise<Result<void, OpenKeyError>> {
  const row = await keyRow(db, ref);
  if (!row) return err('NO_KEY' as const);
  const ring = await getKeyRing(db, ref.tenantId, subject);
  if (!ring.ok) return err(ringError(ring.err.type));
  const key = await openKeyById(db, row.id, ring.val, 0);
  if (!key.ok) return key;
  await upsertWrapping(
    db,
    ref.tenantId,
    row.id,
    'automation',
    subject,
    wrapKey(key.val, ring.val.automationKey),
    ring.val.version,
    null
  );
  return ok();
}

/**
 * Many resources' keys at once, each as a named person: one ring per
 * distinct subject and one query for the wrappings. The map holds only
 * what opened; a caller decides what to do about the rest.
 */
export async function openResourceKeys(
  db: Kysely<DB>,
  tenantId: string,
  kind: ResourceKeyKind,
  entries: { resourceId: string; subject: string }[]
): Promise<Map<string, ResourceKey>> {
  const out = new Map<string, ResourceKey>();
  if (entries.length === 0) return out;
  const keys = await db
    .selectFrom('resource_keys')
    .select(['id', 'resource_id'])
    .where('resource_kind', '=', kind)
    .where(
      'resource_id',
      'in',
      entries.map((entry) => entry.resourceId)
    )
    .execute();
  const keyIdOf = new Map(keys.map((row) => [row.resource_id, row.id]));
  const rows = await grantRows(
    db,
    keys.map((row) => row.id)
  );
  const rowsByKey = new Map<string, GrantRow[]>();
  for (const row of rows) {
    const list = rowsByKey.get(row.resource_key_id) ?? [];
    list.push(row);
    rowsByKey.set(row.resource_key_id, list);
  }
  const rings = new Map<string, KeyRing | null>();
  for (const entry of entries) {
    const keyId = keyIdOf.get(entry.resourceId);
    if (!keyId || out.has(entry.resourceId)) continue;
    let ring = rings.get(entry.subject);
    if (ring === undefined) {
      const resolved = await getKeyRing(db, tenantId, entry.subject);
      ring = resolved.ok ? resolved.val : null;
      rings.set(entry.subject, ring);
    }
    if (!ring) continue;
    const direct = openDirect(rowsByKey.get(keyId) ?? [], ring);
    if (direct.key) {
      if (direct.via === 'public')
        await convertPublicWrapping(db, tenantId, keyId, ring, direct.key);
      out.set(entry.resourceId, { id: keyId, key: direct.key });
      continue;
    }
    const viaParent = await openThroughParents(db, rowsByKey.get(keyId) ?? [], ring, 0);
    if (viaParent?.ok) out.set(entry.resourceId, { id: keyId, key: viaParent.val });
  }
  return out;
}

/**
 * Sharing: open the key as `fromSubject`, seal it to `toSubject`'s public
 * key. The grantee need not be present, and nothing is re-encrypted — the
 * content stays under the one data key; only a new wrapping is written.
 * A grantee who already holds the key through their own wrappings is left
 * as they are.
 */
export async function shareResourceKey(
  db: Kysely<DB>,
  ref: ResourceRef,
  fromSubject: string,
  toSubject: string
): Promise<Result<void, ShareKeyError>> {
  const opened = await openResourceKey(db, ref, fromSubject);
  if (!opened.ok) return opened;
  const grantee = await readKeyRow(db, ref.tenantId, toSubject);
  if (!grantee || grantee.mode !== 'held' || !grantee.public_key) {
    return err('GRANTEE_NOT_ENROLLED' as const);
  }
  const held = await db
    .selectFrom('resource_key_grants')
    .select('holder_kind')
    .where('resource_key_id', '=', opened.val.id)
    .where('holder', '=', toSubject)
    .where('holder_kind', 'in', ['user', 'automation'])
    .executeTakeFirst();
  if (held) return ok();
  await upsertWrapping(
    db,
    ref.tenantId,
    opened.val.id,
    'public',
    toSubject,
    sealToPublicKey(Buffer.from(grantee.public_key, 'base64'), opened.val.key),
    grantee.version,
    fromSubject
  );
  return ok();
}

/**
 * A chat's key under its project's: whoever opens the project opens the
 * chat. Both keys are opened as `bySubject`; the wrapping is under the
 * parent's key, so a new member of the project needs nothing more.
 */
export async function wrapResourceKeyUnder(
  db: Kysely<DB>,
  ref: ResourceRef,
  bySubject: string,
  parent: ResourceRef
): Promise<Result<void, OpenKeyError>> {
  const child = await openResourceKey(db, ref, bySubject);
  if (!child.ok) return child;
  const parentKey = await openResourceKey(db, parent, bySubject);
  if (!parentKey.ok) return parentKey;
  await upsertWrapping(
    db,
    ref.tenantId,
    child.val.id,
    'resource',
    parentKey.val.id,
    wrapKey(child.val.key, parentKey.val.key),
    0,
    bySubject
  );
  return ok();
}

/** Unsharing: forget this person's wrappings. The key itself and everyone else's stay. */
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
    .where('holder', '=', subject)
    .where('holder_kind', 'in', ['user', 'automation', 'public'])
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/** The resource is gone: its key and every wrapping go with it (grants cascade). */
export async function deleteResourceKey(db: Kysely<DB>, ref: ResourceRef): Promise<void> {
  await db
    .deleteFrom('resource_keys')
    .where('resource_kind', '=', ref.kind)
    .where('resource_id', '=', ref.resourceId)
    .execute();
}

export interface ResourceKeyHolder {
  holderKind: HolderKind;
  holder: string;
  grantedBy: string | null;
  kekVersion: number;
}

function holderKindOf(value: string): HolderKind {
  return value === 'automation' || value === 'public' || value === 'resource' ? value : 'user';
}

/** Who holds a wrapping of this resource's key — for the owner's view and for tests. */
export async function listResourceKeyHolders(
  db: Kysely<DB>,
  ref: ResourceRef
): Promise<ResourceKeyHolder[]> {
  const row = await keyRow(db, ref);
  if (!row) return [];
  const rows = await db
    .selectFrom('resource_key_grants')
    .select(['holder_kind', 'holder', 'granted_by', 'kek_version'])
    .where('resource_key_id', '=', row.id)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((grant) => ({
    holderKind: holderKindOf(grant.holder_kind),
    holder: grant.holder,
    grantedBy: grant.granted_by,
    kekVersion: grant.kek_version,
  }));
}

/**
 * Keys whose resource no longer exists — the sweep's half of "the app
 * deletes a resource's key with the resource". Returns how many were
 * removed.
 */
export async function pruneOrphanResourceKeys(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ id: string }>`
    DELETE FROM resource_keys k
     WHERE (k.resource_kind = 'chat' AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = k.resource_id))
        OR (k.resource_kind = 'chat_project' AND NOT EXISTS (SELECT 1 FROM chat_projects p WHERE p.id = k.resource_id))
        OR (k.resource_kind = 'prompt_library' AND NOT EXISTS (SELECT 1 FROM prompt_libraries l WHERE l.id = k.resource_id))
    RETURNING k.id
  `.execute(db);
  return result.rows.length;
}
