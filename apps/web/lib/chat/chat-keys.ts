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
 * No key is derived here. Every key comes from the delegate
 * (docs/delegate-key-design.md), the one process that holds the master:
 * this module asks it for a resource's data key and builds the cipher
 * around that, so the web app handles exactly the key of the thing the
 * request is about and never a person's.
 *
 * Nothing is derived, so "as the owner" works only while the owner's key
 * is DELEGATED to the delegate (docs/delegate-key-design.md): their
 * browser session's delegation while they are signed in, their automation
 * delegation for the chats their agents write into while they are away.
 * A viewer therefore opens a shared chat through their own wrapping first
 * (a sealed box to their public key, or the project key's wrapping of a
 * member's chat); only a reader with no wrapping of their own falls back
 * to the owner. When nothing opens, the cipher says why —
 * `unavailableCipher('delegation')` or `('not-enrolled')` — reads as a
 * marker and refuses to write.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ResourceKey, ResourceKeyKind, ResourceRef } from '@renkei/user-keys';
import { delegateClient, type KeyOpError } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';
import {
  resourceCipher,
  unavailableCipher,
  type CipherUnavailable,
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

/** Why content is unavailable, from the key op's verdict: not delegated, not enrolled, the delegate out of reach, or no key. */
export function unavailableReasonOf(reason: KeyOpError): CipherUnavailable {
  if (reason === 'NEEDS_DELEGATION' || reason === 'NEEDS_SESSION') return 'delegation';
  if (reason === 'NOT_ENROLLED' || reason === 'NO_USER_KEY') return 'not-enrolled';
  if (
    reason === 'DELEGATE_UNCONFIGURED' ||
    reason === 'DELEGATE_UNREACHABLE' ||
    reason === 'DELEGATE_ERROR'
  ) {
    return 'delegate';
  }
  return 'no-key';
}

/** The cipher for a key-store failure. */
function failedCipher(reason: KeyOpError): ContentCipher {
  return unavailableCipher(unavailableReasonOf(reason));
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
): Promise<ResourceKey | KeyOpError> {
  const keys = delegateClient();
  const target = ref(kind, resource.tenantId, resource.id);
  const before = await keys.openResourceKey(target, resource.ownerSubject);
  if (before.ok) return before.val;
  if (before.err.type !== 'NO_KEY') return before.err.type;
  const created = await keys.ensureResourceKey(target, resource.ownerSubject);
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
    const shared = await keys.shareResourceKey(target, resource.ownerSubject, grantee);
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

/**
 * A chat's key under its project's (docs/delegate-key-design.md, phase 4):
 * whoever opens the project opens the chat, with no wrapping per member.
 * Done when a chat is created in or moved into a project, as its owner;
 * best effort — a member's first read heals a missing one (cipherFor).
 */
export async function wrapKeyUnderProject(
  db: Kysely<DB>,
  chat: KeyedResource,
  projectId: string
): Promise<boolean> {
  const key = await ensureKey(db, 'chat', chat);
  if (typeof key === 'string') return false;
  const wrapped = await delegateClient().wrapResourceKeyUnder(
    ref('chat', chat.tenantId, chat.id),
    chat.ownerSubject,
    ref('chat_project', chat.tenantId, projectId)
  );
  if (!wrapped.ok) {
    warn('chat key could not be wrapped under its project: {reason}', {
      tenantId: chat.tenantId,
      resourceId: chat.id,
      projectId,
      reason: wrapped.err.type,
    });
  }
  return wrapped.ok;
}

/** A new resource's key, wrapped for its owner; null, with a warning, on a key-store failure. */
export async function createKey(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource
): Promise<ResourceKey | null> {
  const created = await delegateClient().createResourceKey(
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
 * them in. Owners mint. Everyone else opens through a wrapping of their
 * own first — the share's sealed box, or the project key's wrapping of a
 * member's chat — and a wrapping that is missing while the access stands
 * is healed on the spot when the owner's key is delegated: the grant is
 * the decision, the wrapping follows it. Only when nothing of the
 * viewer's own opens does the read fall back to the owner's key.
 */
export async function cipherFor(
  db: Kysely<DB>,
  kind: KeyedKind,
  resource: KeyedResource,
  viewerSubject: string,
  via: 'owner' | 'grant' | 'project',
  projectId: string | null = null
): Promise<ContentCipher> {
  const target = ref(kind, resource.tenantId, resource.id);
  if (via === 'owner') {
    const key = await ensureKey(db, kind, resource);
    return typeof key === 'string' ? failedCipher(key) : resourceCipher(key);
  }
  const keys = delegateClient();
  const own = await keys.openResourceKey(target, viewerSubject);
  if (own.ok) return resourceCipher(own.val);
  if (own.err.type === 'NEEDS_DELEGATION' || own.err.type === 'NEEDS_SESSION') {
    return unavailableCipher('delegation');
  }
  if (own.err.type === 'NO_ACCESS' || own.err.type === 'NO_KEY') {
    // The access stands; the wrapping is missing. Heal it, as the owner.
    const minted = await ensureKey(db, kind, resource);
    if (typeof minted !== 'string') {
      const healed =
        via === 'project' && kind === 'chat' && projectId
          ? await keys.wrapResourceKeyUnder(
              target,
              resource.ownerSubject,
              ref('chat_project', resource.tenantId, projectId)
            )
          : await keys.shareResourceKey(target, resource.ownerSubject, viewerSubject);
      if (healed.ok) {
        const reopened = await keys.openResourceKey(target, viewerSubject);
        if (reopened.ok) return resourceCipher(reopened.val);
      } else if (healed.err.type === 'GRANTEE_NOT_ENROLLED') {
        return unavailableCipher('not-enrolled');
      }
    }
  }
  return cipherAsOwner(db, kind, resource);
}

/**
 * The resource opened on its owner's behalf — every process acting while
 * nobody is signed in (a resumed turn, a worker's note, a sweep), which
 * works while the owner's key is delegated: their session's, or their
 * automation key for the chats their agents write into.
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
  const keys = delegateClient();
  const asViewer = await keys.openResourceKeys(
    tenantId,
    'chat',
    chats.map((chat) => ({ resourceId: chat.id, subject: viewerSubject }))
  );
  if (!asViewer.ok) {
    for (const chat of chats) out.set(chat.id, failedCipher(asViewer.err.type));
    return out;
  }
  const rest = chats.filter(
    (chat) => !asViewer.val.has(chat.id) && chat.ownerSubject !== viewerSubject
  );
  const asOwner = await keys.openResourceKeys(
    tenantId,
    'chat',
    rest.map((chat) => ({ resourceId: chat.id, subject: chat.ownerSubject }))
  );
  for (const chat of chats) {
    const key = asViewer.val.get(chat.id) ?? (asOwner.ok ? asOwner.val.get(chat.id) : undefined);
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
  const shared = await delegateClient().shareResourceKey(
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
  _db: Kysely<DB>,
  kind: KeyedKind,
  tenantId: string,
  resourceId: string,
  granteeSubject: string
): Promise<void> {
  await delegateClient().revokeResourceKey(ref(kind, tenantId, resourceId), granteeSubject);
}

/** The resource is gone: so is its key, with every wrapping. */
export async function deleteKey(
  _db: Kysely<DB>,
  kind: KeyedKind,
  tenantId: string,
  resourceId: string
): Promise<void> {
  await delegateClient().deleteResourceKey(ref(kind, tenantId, resourceId));
}
