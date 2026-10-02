/**
 * A chat's key, as a cipher — the bridge from the key store
 * (`@renkei/user-keys`) to the chat's content modules
 * (docs/user-encryption-keys-design.md).
 *
 * Who opens with what:
 *   - the OWNER opens with their own wrapping, and a chat from before
 *     keys gets one on the owner's first keyed act (wrapped for everyone
 *     the chat was already shared with, so no viewer loses the rows that
 *     follow);
 *   - a NAMED VIEWER (`resource_access_grants`) opens with the wrapping
 *     the share made for them; a grant from before the key store, or a
 *     share whose rewrap did not land, is healed on the spot — the access
 *     grant is the decision, the wrapping follows it;
 *   - a PROJECT MEMBER reading a fellow member's chat, and every process
 *     acting on the chat while nobody is looking (a resumed turn, a
 *     worker's note, a sweep), open AS THE OWNER — the server can derive
 *     any KEK from the master, and these readers are the ones that
 *     derivation exists for. A key hierarchy for projects is the noted
 *     follow-up.
 *
 * A chat with no key at all (not yet re-sealed) gets the legacy cipher:
 * its `renc1` rows open, and nothing new is written under it except by
 * its owner, whose first write mints the key.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  createResourceKey,
  deleteResourceKey,
  ensureResourceKey,
  openResourceKey,
  openResourceKeys,
  revokeResourceKey,
  shareResourceKey,
  type ResourceKey,
  type ResourceRef,
} from '@renkei/user-keys';
import { logger } from '@/lib/logger';
import { legacyCipher, resourceCipher, type ContentCipher } from './content-crypto';
import type { ChatRow } from './store';

const ref = (tenantId: string, chatId: string): ResourceRef => ({
  tenantId,
  kind: 'chat',
  resourceId: chatId,
});

function warn(message: string, fields: Record<string, unknown>): void {
  logger.warn(message, { component: 'chat/keys', ...fields });
}

/** Everyone the chat is currently shared with, for wrapping a newly minted key. */
async function activeGrantees(db: Kysely<DB>, tenantId: string, chatId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('resource_access_grants')
    .select('grantee_subject')
    .where('tenant_id', '=', tenantId)
    .where('resource_kind', '=', 'chat')
    .where('resource_id', '=', chatId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .execute();
  return rows.map((row) => row.grantee_subject);
}

/**
 * The chat's key for its owner, minted if the chat has none yet. A fresh
 * key is wrapped for every current grantee in the same breath.
 */
export async function ensureChatKey(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  ownerSubject: string
): Promise<ResourceKey | null> {
  const before = await openResourceKey(db, ref(tenantId, chatId), ownerSubject);
  if (before.ok) return before.val;
  if (before.err.type !== 'NO_KEY') {
    warn('chat key could not be opened for its owner: {reason}', {
      tenantId,
      chatId,
      reason: before.err.type,
    });
    return null;
  }
  const created = await ensureResourceKey(db, ref(tenantId, chatId), ownerSubject);
  if (!created.ok) {
    warn('chat key could not be created: {reason}', { tenantId, chatId, reason: created.err.type });
    return null;
  }
  for (const grantee of await activeGrantees(db, tenantId, chatId)) {
    const shared = await shareResourceKey(db, ref(tenantId, chatId), ownerSubject, grantee);
    if (!shared.ok) {
      warn('chat key could not be wrapped for an existing viewer: {reason}', {
        tenantId,
        chatId,
        reason: shared.err.type,
      });
    }
  }
  return created.val;
}

/** A new chat's key, wrapped for its owner; null (and a warning) only on a key-store failure. */
export async function createChatKey(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  ownerSubject: string
): Promise<ResourceKey | null> {
  const created = await createResourceKey(db, ref(tenantId, chatId), ownerSubject);
  if (created.ok) return created.val;
  warn('chat key could not be created: {reason}', { tenantId, chatId, reason: created.err.type });
  return null;
}

/**
 * The cipher for one person opening one chat, given how access.ts let
 * them in. Owners mint; named viewers are healed; everyone else reads as
 * the owner.
 */
export async function chatCipherFor(
  db: Kysely<DB>,
  chat: ChatRow,
  viewerSubject: string,
  via: 'owner' | 'grant' | 'project'
): Promise<ContentCipher> {
  if (via === 'owner') {
    const key = await ensureChatKey(db, chat.tenantId, chat.id, chat.ownerSubject);
    return key ? resourceCipher(key) : legacyCipher;
  }
  if (via === 'grant') {
    const own = await openResourceKey(db, ref(chat.tenantId, chat.id), viewerSubject);
    if (own.ok) return resourceCipher(own.val);
    if (own.err.type === 'NO_KEY') return legacyCipher;
    if (own.err.type === 'NO_ACCESS') {
      // The access grant stands; the wrapping is missing. Heal it.
      const healed = await shareResourceKey(
        db,
        ref(chat.tenantId, chat.id),
        chat.ownerSubject,
        viewerSubject
      );
      if (healed.ok) {
        const reopened = await openResourceKey(db, ref(chat.tenantId, chat.id), viewerSubject);
        if (reopened.ok) return resourceCipher(reopened.val);
      }
    }
  }
  return chatCipherAsOwner(db, chat);
}

/**
 * The chat opened on its owner's behalf — for a project member's read and
 * for every process acting on a chat while nobody is signed in.
 */
export async function chatCipherAsOwner(db: Kysely<DB>, chat: ChatRow): Promise<ContentCipher> {
  const opened = await openResourceKey(db, ref(chat.tenantId, chat.id), chat.ownerSubject);
  if (opened.ok) return resourceCipher(opened.val);
  if (opened.err.type !== 'NO_KEY') {
    warn('chat key could not be opened as its owner: {reason}', {
      tenantId: chat.tenantId,
      chatId: chat.id,
      reason: opened.err.type,
    });
  }
  return legacyCipher;
}

/** `chatCipherAsOwner` by id, for callers holding only the chat id. */
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
  if (!row) return legacyCipher;
  const opened = await openResourceKey(db, ref(tenantId, chatId), row.owner_subject);
  return opened.ok ? resourceCipher(opened.val) : legacyCipher;
}

/**
 * Ciphers for many chats one person may read — the sidebar's set, for
 * search. Each chat is first tried as the viewer (their own chats and
 * the ones shared with them), then as its owner (the project members'
 * chats). A chat with no key opens with the legacy cipher.
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
    out.set(chat.id, key ? resourceCipher(key) : legacyCipher);
  }
  return out;
}

/**
 * Sharing: the owner's unwrap and the grantee's wrap, in the key store's
 * terms. A chat with no key yet gets one first, so the share is a share
 * of a key and not only a row.
 */
export async function shareChatKey(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  ownerSubject: string,
  granteeSubject: string
): Promise<boolean> {
  const key = await ensureChatKey(db, tenantId, chatId, ownerSubject);
  if (!key) return false;
  const shared = await shareResourceKey(db, ref(tenantId, chatId), ownerSubject, granteeSubject);
  if (!shared.ok) {
    warn('chat key could not be shared: {reason}', {
      tenantId,
      chatId,
      reason: shared.err.type,
    });
  }
  return shared.ok;
}

/** Unsharing: the grantee's wrapping is forgotten; the key and the owner's stay. */
export async function revokeChatKey(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  granteeSubject: string
): Promise<void> {
  await revokeResourceKey(db, ref(tenantId, chatId), granteeSubject);
}

/** The chat is gone: so is its key, with every wrapping. */
export async function deleteChatKey(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<void> {
  await deleteResourceKey(db, ref(tenantId, chatId));
}
