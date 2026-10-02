/**
 * Bring-your-own-key against a real database (skipped without
 * DATABASE_URL): adopting a passphrase rewraps everything the person
 * holds — resource key wrappings and values sealed directly under their
 * KEK — and leaves the key unlocked; locking makes every one of them
 * unopenable and the status says so; the right passphrase unlocks, the
 * wrong one does not; reverting puts them back on a managed key with
 * everything still readable.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { decryptWithResourceKey, encryptWithResourceKey } from '@renkei/crypto';
import {
  adoptOwnKey,
  getUserKek,
  getUserKeyStatus,
  lockOwnKey,
  revertToManagedKey,
  rotateUserKek,
  unlockOwnKey,
} from './kek';
import { createResourceKey, openResourceKey, shareResourceKey } from './resource-keys';
import { openForSubject, sealForSubject } from './user-sealed';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('bring-your-own-key', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const alice = `alice-${tenantId.slice(0, 8)}`;
  const bob = `bob-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const sharedChatId = randomUUID();
  const ref = { tenantId, kind: 'chat' as const, resourceId: chatId };
  const sharedRef = { tenantId, kind: 'chat' as const, resourceId: sharedChatId };
  const passphrase = 'correct horse battery staple';
  let sealedContent = '';
  let sealedToken = '';
  let sealedMemory = '';

  beforeAll(async () => {
    process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `own-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('chats')
      .values([
        { id: chatId, tenant_id: tenantId, owner_subject: alice },
        { id: sharedChatId, tenant_id: tenantId, owner_subject: bob },
      ])
      .execute();
    // Alice's own chat, a chat Bob shared with her, a credential and a memory note.
    const key = await createResourceKey(db, ref, alice);
    if (!key.ok) throw new Error('key');
    sealedContent = encryptWithResourceKey('mine', key.val.id, key.val.key);
    const bobs = await createResourceKey(db, sharedRef, bob);
    if (!bobs.ok) throw new Error('key');
    expect((await shareResourceKey(db, sharedRef, bob, alice)).ok).toBe(true);
    const token = await sealForSubject(db, tenantId, alice, 'oauth-token');
    if (!token.ok) throw new Error('seal');
    sealedToken = token.val;
    await db
      .insertInto('provider_grants')
      .values({
        tenant_id: tenantId,
        provider: 'atlassian',
        provider_account_id: 'acct',
        subject: alice,
        client_id: 'c',
        display_name: 'Alice',
        encrypted_access_token: sealedToken,
        encrypted_refresh_token: sealedToken,
        expires_at: new Date(),
        requested_scopes: [],
        granted_scopes: [],
        metadata: '{}',
      })
      .execute();
    const memory = await sealForSubject(db, tenantId, alice, 'likes short answers');
    if (!memory.ok) throw new Error('seal');
    sealedMemory = memory.val;
    await db
      .insertInto('chat_user_memories')
      .values({ tenant_id: tenantId, owner_subject: alice, kind: 'entry', content: sealedMemory })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  const readAll = async () => {
    const own = await openResourceKey(db, ref, alice);
    const shared = await openResourceKey(db, sharedRef, alice);
    const grant = await db
      .selectFrom('provider_grants')
      .select('encrypted_access_token')
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', alice)
      .executeTakeFirstOrThrow();
    const memory = await db
      .selectFrom('chat_user_memories')
      .select('content')
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', alice)
      .executeTakeFirstOrThrow();
    return {
      own: own.ok ? decryptWithResourceKey(sealedContent, own.val.id, own.val.key) : own,
      shared: shared.ok,
      token: await openForSubject(db, tenantId, alice, grant.encrypted_access_token),
      memory: await openForSubject(db, tenantId, alice, memory.content),
      rawToken: grant.encrypted_access_token,
      rawMemory: memory.content,
    };
  };

  it('starts managed and readable', async () => {
    expect(await getUserKeyStatus(db, tenantId, alice)).toMatchObject({
      mode: 'managed',
      locked: false,
    });
    const all = await readAll();
    expect(all.own.ok && all.own.val).toBe('mine');
    expect(all.shared).toBe(true);
    expect(all.token.ok && all.token.val).toBe('oauth-token');
    expect(all.memory.ok && all.memory.val).toBe('likes short answers');
  });

  it('refuses a short passphrase', async () => {
    expect(await adoptOwnKey(db, tenantId, alice, 'short')).toMatchObject({
      ok: false,
      err: { type: 'PASSPHRASE_TOO_SHORT' },
    });
  });

  it('adopting a passphrase rewraps everything and leaves the key unlocked', async () => {
    const before = await getUserKek(db, tenantId, alice);
    const adopted = await adoptOwnKey(db, tenantId, alice, passphrase, { unlockMs: 60 * 60_000 });
    expect(adopted.ok && adopted.val).toMatchObject({ mode: 'own', locked: false, version: 2 });
    expect(adopted.ok && adopted.val.unlockedUntil).toBeInstanceOf(Date);
    const after = await getUserKek(db, tenantId, alice);
    expect(before.ok && after.ok && after.val.key.equals(before.val.key)).toBe(false);
    const all = await readAll();
    expect(all.own.ok && all.own.val).toBe('mine');
    expect(all.shared).toBe(true);
    expect(all.token.ok && all.token.val).toBe('oauth-token');
    expect(all.memory.ok && all.memory.val).toBe('likes short answers');
    // The sealed values were rewritten (new ciphertext), the content untouched.
    expect(all.rawToken).not.toBe(sealedToken);
    expect(all.rawMemory).not.toBe(sealedMemory);
    // Nothing on the row derives the key: the salt and verifier are not it.
    const row = await db
      .selectFrom('user_encryption_keys')
      .select(['mode', 'verifier', 'sealed_kek', 'unlocked_until'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', alice)
      .executeTakeFirstOrThrow();
    expect(row.mode).toBe('own');
    expect(row.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sealed_kek).toBeTruthy();
    // A managed rotation is not for an own key.
    expect(await rotateUserKek(db, tenantId, alice)).toMatchObject({
      ok: false,
      err: { type: 'NOT_MANAGED' },
    });
    // Bob, untouched, still opens the chat he shared.
    expect((await openResourceKey(db, sharedRef, bob)).ok).toBe(true);
  });

  it('locking makes everything unopenable, for the person and for Renkei alike', async () => {
    expect(await lockOwnKey(db, tenantId, alice)).toMatchObject({ mode: 'own', locked: true });
    expect(await getUserKek(db, tenantId, alice)).toMatchObject({
      ok: false,
      err: { type: 'KEY_LOCKED' },
    });
    const all = await readAll();
    expect(all.own.ok).toBe(false);
    expect(all.shared).toBe(false);
    expect(!all.token.ok && all.token.err.type).toBe('KEY_LOCKED');
    expect(!all.memory.ok && all.memory.err.type).toBe('KEY_LOCKED');
    // Nobody can seal a new value for her either.
    expect((await sealForSubject(db, tenantId, alice, 'x')).ok).toBe(false);
    // Bob's wrapping of the shared chat is his own and still opens.
    expect((await openResourceKey(db, sharedRef, bob)).ok).toBe(true);
  });

  it('the wrong passphrase stays locked; the right one unlocks for the window', async () => {
    expect(await unlockOwnKey(db, tenantId, alice, 'not the passphrase')).toMatchObject({
      ok: false,
      err: { type: 'WRONG_PASSPHRASE' },
    });
    expect(await getUserKeyStatus(db, tenantId, alice)).toMatchObject({ locked: true });
    const unlocked = await unlockOwnKey(db, tenantId, alice, passphrase, { unlockMs: 90_000 });
    expect(unlocked.ok && unlocked.val.locked).toBe(false);
    expect(
      unlocked.ok &&
        unlocked.val.unlockedUntil !== null &&
        unlocked.val.unlockedUntil.getTime() - Date.now() <= 90_000
    ).toBe(true);
    const all = await readAll();
    expect(all.own.ok && all.own.val).toBe('mine');
    expect(all.shared).toBe(true);
    expect(all.token.ok && all.token.val).toBe('oauth-token');
  });

  it('an expired window reads as locked', async () => {
    await db
      .updateTable('user_encryption_keys')
      .set({ unlocked_until: new Date(Date.now() - 1000) })
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', alice)
      .execute();
    expect(await getUserKeyStatus(db, tenantId, alice)).toMatchObject({ locked: true });
    expect((await openResourceKey(db, ref, alice)).ok).toBe(false);
    await unlockOwnKey(db, tenantId, alice, passphrase);
  });

  it('unlocking a managed key is not a thing', async () => {
    expect(await unlockOwnKey(db, tenantId, bob, passphrase)).toMatchObject({
      ok: false,
      err: { type: 'NOT_OWN_KEY' },
    });
  });

  it('reverting needs the passphrase and lands everything back on a managed key', async () => {
    expect(await revertToManagedKey(db, tenantId, alice, 'wrong')).toMatchObject({
      ok: false,
      err: { type: 'WRONG_PASSPHRASE' },
    });
    await lockOwnKey(db, tenantId, alice);
    // Works from a locked state: the passphrase is the proof, not the window.
    const reverted = await revertToManagedKey(db, tenantId, alice, passphrase);
    expect(reverted.ok && reverted.val).toMatchObject({
      mode: 'managed',
      locked: false,
      version: 3,
    });
    const all = await readAll();
    expect(all.own.ok && all.own.val).toBe('mine');
    expect(all.shared).toBe(true);
    expect(all.token.ok && all.token.val).toBe('oauth-token');
    expect(all.memory.ok && all.memory.val).toBe('likes short answers');
    const row = await db
      .selectFrom('user_encryption_keys')
      .select(['verifier', 'sealed_kek', 'unlocked_until'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', alice)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ verifier: null, sealed_kek: null, unlocked_until: null });
    // And a managed rotation works again, carrying every value along.
    const rotated = await rotateUserKek(db, tenantId, alice);
    expect(rotated.ok && rotated.val.rewrapped).toBe(4);
    const again = await readAll();
    expect(again.token.ok && again.token.val).toBe('oauth-token');
    expect(again.own.ok && again.own.val).toBe('mine');
  });
});
