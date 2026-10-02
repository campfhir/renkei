/**
 * The keys behind the chat's content, as ciphers — the bridge from the key
 * store (`@renkei/user-keys`) to the chat's content modules
 * (docs/user-encryption-keys-design.md).
 *
 * Three kinds of key, one rule each:
 *
 *   - A CHAT's key, and a PROJECT's key, are resource keys: minted with
 *     the resource, held wrapped by each person who may open it. The
 *     OWNER opens with their own wrapping (and a resource from before keys
 *     gets one on the owner's first act, wrapped for everyone it was
 *     already shared with). A NAMED VIEWER (`resource_access_grants`)
 *     opens with the wrapping the share made for them; a wrapping that is
 *     missing while the grant stands is healed on the spot — the grant is
 *     the decision, the wrapping follows it. A PROJECT MEMBER reading a
 *     fellow member's chat, a reader of a PUBLISHED project, and every
 *     process acting while nobody is signed in (a resumed turn, a
 *     worker's note, a sweep) open AS THE OWNER.
 *   - A PERSON's key is theirs alone: their own memory is sealed directly
 *     under it, never wrapped for anyone else.
 *
 * "As the owner" works because the server derives a managed KEK from the
 * master. A person on their OWN key (bring-your-own-key) changes that:
 * while their key is locked, nothing of theirs opens as them — not a
 * resumed turn, not a worker's note. Every path here answers that with an
 * `unavailableCipher('locked')`, which reads as a marker and refuses to
 * write. A viewer's own wrapping of a shared chat still opens, since it
 * is under the viewer's key.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  createResourceKey,
  deleteResourceKey,
  ensureResourceKey,
  ensureUserKek,
  openResourceKey,
  openResourceKeys,
  revokeResourceKey,
  shareResourceKey,
  type OpenKeyError,
  type ResourceKey,
  type ResourceKeyKind,
  type ResourceRef,
} from '@renkei/user-keys';
import { logger } from '@/lib/logger';
import {
  resourceCipher,
  unavailableCipher,
  userCipher,
  type ContentCipher,
} from './content-crypto';

/** What a keyed resource is to this module: its id, tenant and owner. */
export interface KeyedResource {
  id: string;
  tenantId: string;
  ownerSubject: string;
}

export type KeyedKind = Extract<ResourceKeyKind, 'chat' | 'chat_project'>;

const ref = (kind: KeyedKind, tenantId: string, resourceId: string): ResourceRef => ({
  tenantId,
  kind,
  resourceId,
});

function warn(message: string, fields: Record<string, unknown>): void {
  logger.warn(message, { component: 'chat/keys', ...fields });
}

/** The cipher for a key-store failure: locked reads as locked, everything else as no key. */
function failedCipher(reason: OpenKeyError): ContentCipher {
  return unavailableCipher(reason === 'KEY_LOCKED' ? 'locked' : 'no-key');
}

/** Everyone the resource is currently shared with, for wrapping a newly minted key. */
async function activeGrantees(
  db: Kysely<DB>,
  kind: KeyedKind,
  tenantId: string,
  resourceId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('resource_access_grants')
    .select('grantee_subject')
    .where('tenant_id', '=', tenantId)
    .where('resource_kind', '=', kind)
    .where('resource_id', '=', resourceId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .execute();
  return rows.map((row) => row.grantee_subject);
}

/**
 * The resource's key for its owner, minted if it has none yet. A fresh key
 * is wrapped for every current grantee in the same breath.
 */
async function ensureKey(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource
): Promise<ResourceKey | OpenKeyError> {
  const target = ref(kind, resource.tenantId, resource.id);
  const before = await openResourceKey(db, target, resource.ownerSubject);
  if (before.ok) return before.val;
  if (before.err.type !== 'NO_KEY') return before.err.type;
  const created = await ensureResourceKey(db, target, resource.ownerSubject);
  if (!created.ok) {
    warn('key could not be created: {reason}', {
      kind,
      tenantId: resource.tenantId,
      resourceId: resource.id,
      reason: created.err.type,
    });
    return created.err.type;
  }
  for (const grantee of await activeGrantees(db, kind, resource.tenantId, resource.id)) {
    const shared = await shareResourceKey(db, target, resource.ownerSubject, grantee);
    if (!shared.ok) {
      warn('key could not be wrapped for an existing viewer: {reason}', {
        kind,
        tenantId: resource.tenantId,
        resourceId: resource.id,
        reason: shared.err.type,
      });
    }
  }
  return created.val;
}

/** A new resource's key, wrapped for its owner; null, with a warning, on a key-store failure. */
export async function createKey(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource
): Promise<ResourceKey | null> {
  const created = await createResourceKey(
    db,
    ref(kind, resource.tenantId, resource.id),
    resource.ownerSubject
  );
  if (created.ok) return created.val;
  warn('key could not be created: {reason}', {
    kind,
    tenantId: resource.tenantId,
    resourceId: resource.id,
    reason: created.err.type,
  });
  return null;
}

/**
 * The cipher for one person opening one resource, given how access.ts let
 * them in. Owners mint; named viewers are healed; everyone else reads as
 * the owner.
 */
export async function cipherFor(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource,
  viewerSubject: string,
  via: 'owner' | 'grant' | 'project' | 'published'
): Promise<ContentCipher> {
  const target = ref(kind, resource.tenantId, resource.id);
  if (via === 'owner') {
    const key = await ensureKey(db, kind, resource);
    return typeof key === 'string' ? failedCipher(key) : resourceCipher(key);
  }
  if (via === 'grant') {
    const own = await openResourceKey(db, target, viewerSubject);
    if (own.ok) return resourceCipher(own.val);
    if (own.err.type === 'KEY_LOCKED') return unavailableCipher('locked');
    if (own.err.type === 'NO_ACCESS') {
      // The access grant stands; the wrapping is missing. Heal it.
      const healed = await shareResourceKey(db, target, resource.ownerSubject, viewerSubject);
      if (healed.ok) {
        const reopened = await openResourceKey(db, target, viewerSubject);
        if (reopened.ok) return resourceCipher(reopened.val);
      }
    }
  }
  return cipherAsOwner(db, kind, resource);
}

/**
 * The resource opened on its owner's behalf — a project member's read, a
 * published project's reader, and every process acting while nobody is
 * signed in.
 */
export async function cipherAsOwner(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource
): Promise<ContentCipher> {
  const key = await ensureKey(db, kind, resource);
  return typeof key === 'string' ? failedCipher(key) : resourceCipher(key);
}

/** `cipherAsOwner` for a chat, by id — for callers holding only the chat id. */
export async function chatCipherById(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<ContentCipher> {
  const row = await db
    .selectFrom('chats')
    .select('owner_subject')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', chatId)
    .executeTakeFirst();
  if (!row) return unavailableCipher('no-key');
  return cipherAsOwner(db, 'chat', { id: chatId, tenantId, ownerSubject: row.owner_subject });
}

/** `cipherAsOwner` for a project, by id. */
export async function projectCipherById(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string
): Promise<ContentCipher> {
  const row = await db
    .selectFrom('chat_projects')
    .select('owner_subject')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (!row) return unavailableCipher('no-key');
  return cipherAsOwner(db, 'chat_project', {
    id: projectId,
    tenantId,
    ownerSubject: row.owner_subject,
  });
}

/** A person's own key as a cipher — for their memory, which is theirs alone. */
export async function userCipherFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<ContentCipher> {
  const kek = await ensureUserKek(db, tenantId, subject);
  if (kek.ok) return userCipher(kek.val.key);
  return unavailableCipher(kek.err.type === 'KEY_LOCKED' ? 'locked' : 'no-key');
}

/**
 * Ciphers for many chats one person may read — the sidebar's set, for
 * search. Each chat is first tried as the viewer (their own chats and
 * the ones shared with them), then as its owner (the project members'
 * chats). A chat that opens neither way gets an unavailable cipher.
 */
export async function chatCiphersFor(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  chats: { id: string; ownerSubject: string }[]
): Promise<Map<string, ContentCipher>> {
  const out = new Map<string, ContentCipher>();
  if (chats.length === 0) return out;
  const asViewer = await openResourceKeys(
    db,
    tenantId,
    'chat',
    chats.map((chat) => ({ resourceId: chat.id, subject: viewerSubject }))
  );
  const rest = chats.filter(
    (chat) => !asViewer.has(chat.id) && chat.ownerSubject !== viewerSubject
  );
  const asOwner = await openResourceKeys(
    db,
    tenantId,
    'chat',
    rest.map((chat) => ({ resourceId: chat.id, subject: chat.ownerSubject }))
  );
  for (const chat of chats) {
    const key = asViewer.get(chat.id) ?? asOwner.get(chat.id);
    out.set(chat.id, key ? resourceCipher(key) : unavailableCipher('no-key'));
  }
  return out;
}

/**
 * Sharing: the owner's unwrap and the grantee's wrap, in the key store's
 * terms. A resource with no key yet gets one first, so the share is a
 * share of a key and not only a row.
 */
export async function shareKey(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource,
  granteeSubject: string
): Promise<boolean> {
  const key = await ensureKey(db, kind, resource);
  if (typeof key === 'string') return false;
  const shared = await shareResourceKey(
    db,
    ref(kind, resource.tenantId, resource.id),
    resource.ownerSubject,
    granteeSubject
  );
  if (!shared.ok) {
    warn('key could not be shared: {reason}', {
      kind,
      tenantId: resource.tenantId,
      resourceId: resource.id,
      reason: shared.err.type,
    });
  }
  return shared.ok;
}

/** Unsharing: the grantee's wrapping is forgotten; the key and the owner's stay. */
export async function revokeKey(
  db: Kysely<DB>,
  kind: KeyedKind,
  tenantId: string,
  resourceId: string,
  granteeSubject: string
): Promise<void> {
  await revokeResourceKey(db, ref(kind, tenantId, resourceId), granteeSubject);
}

/** The resource is gone: so is its key, with every wrapping. */
export async function deleteKey(
  db: Kysely<DB>,
  kind: KeyedKind,
  tenantId: string,
  resourceId: string
): Promise<void> {
  await deleteResourceKey(db, ref(kind, tenantId, resourceId));
}
