/**
 * The key store against a real database (skipped without DATABASE_URL):
 * a chat's key opens for its owner and nobody else until shared; sharing
 * wraps the SAME key for the grantee without touching the content;
 * revoking forgets only that wrapping; a rotation rewraps everything the
 * person holds and the old KEK opens nothing; a shred leaves the person
 * unable to open anything at all.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import {
  decryptWithResourceKey,
  encryptWithResourceKey,
  deriveUserKek,
  userKeyMaster,
  unwrapKey,
} from '@renkei/crypto';
import {
  createResourceKey,
  deleteResourceKey,
  ensureResourceKey,
  listResourceKeyHolders,
  openResourceKey,
  openResourceKeys,
  pruneOrphanChatKeys,
  revokeResourceKey,
  shareResourceKey,
} from './resource-keys';
import { ensureUserKek, getUserKek, rotateUserKek, shredUserKek } from './kek';
import { openForSubject, sealForSubject } from './user-sealed';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('user keys and the resource key store', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const friend = `friend-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const ref = { tenantId, kind: 'chat' as const, resourceId: chatId };

  beforeAll(async () => {
    process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `keys-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('chats')
      .values({ id: chatId, tenant_id: tenantId, owner_subject: owner })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('mints a key for the owner, and nobody else can open it', async () => {
    expect(await openResourceKey(db, ref, owner)).toMatchObject({
      ok: false,
      err: { type: 'NO_KEY' },
    });
    const created = await createResourceKey(db, ref, owner);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const reopened = await openResourceKey(db, ref, owner);
    expect(reopened.ok && reopened.val.id).toBe(created.val.id);
    expect(reopened.ok && reopened.val.key.equals(created.val.key)).toBe(true);
    expect(await openResourceKey(db, ref, friend)).toMatchObject({
      ok: false,
      err: { type: 'NO_ACCESS' },
    });
    // The salt row exists only for people who hold a key.
    expect((await getUserKek(db, tenantId, owner)).ok).toBe(true);
    expect(await getUserKek(db, tenantId, friend)).toMatchObject({
      ok: false,
      err: { type: 'NO_USER_KEY' },
    });
  });

  it('creating again hands back the key that already exists', async () => {
    const first = await openResourceKey(db, ref, owner);
    const again = await createResourceKey(db, ref, owner);
    expect(first.ok && again.ok && again.val.key.equals(first.val.key)).toBe(true);
    const ensured = await ensureResourceKey(db, ref, owner);
    expect(first.ok && ensured.ok && ensured.val.key.equals(first.val.key)).toBe(true);
  });

  it('sharing wraps the same key for the grantee; content need not move', async () => {
    const asOwner = await openResourceKey(db, ref, owner);
    if (!asOwner.ok) throw new Error('owner cannot open');
    const sealed = encryptWithResourceKey('only between us', asOwner.val.id, asOwner.val.key);

    const shared = await shareResourceKey(db, ref, owner, friend);
    expect(shared.ok).toBe(true);
    const asFriend = await openResourceKey(db, ref, friend);
    expect(asFriend.ok && asFriend.val.key.equals(asOwner.val.key)).toBe(true);
    if (!asFriend.ok) return;
    const opened = decryptWithResourceKey(sealed, asFriend.val.id, asFriend.val.key);
    expect(opened.ok && opened.val).toBe('only between us');

    // The grantee's wrapping is under THEIR KEK, not the owner's.
    const holders = await listResourceKeyHolders(db, ref);
    expect(holders.map((h) => [h.subject, h.grantedBy])).toEqual([
      [owner, null],
      [friend, owner],
    ]);
    const friendKek = await getUserKek(db, tenantId, friend);
    const ownerKek = await getUserKek(db, tenantId, owner);
    if (!friendKek.ok || !ownerKek.ok) throw new Error('keks');
    const friendRow = await db
      .selectFrom('resource_key_grants')
      .select('wrapped_key')
      .where('resource_key_id', '=', asOwner.val.id)
      .where('subject', '=', friend)
      .executeTakeFirstOrThrow();
    expect(unwrapKey(friendRow.wrapped_key, friendKek.val.key).ok).toBe(true);
    expect(unwrapKey(friendRow.wrapped_key, ownerKek.val.key).ok).toBe(false);
  });

  it('only someone holding the key can share it', async () => {
    expect(await shareResourceKey(db, ref, stranger, friend)).toMatchObject({
      ok: false,
      err: { type: 'NO_ACCESS' },
    });
  });

  it('opens many at once, each as a named person', async () => {
    const other = randomUUID();
    await db
      .insertInto('chats')
      .values({ id: other, tenant_id: tenantId, owner_subject: friend })
      .execute();
    const otherRef = { ...ref, resourceId: other };
    const otherKey = await createResourceKey(db, otherRef, friend);
    if (!otherKey.ok) throw new Error('create');
    const keys = await openResourceKeys(db, tenantId, 'chat', [
      { resourceId: chatId, subject: friend },
      { resourceId: other, subject: friend },
      { resourceId: randomUUID(), subject: friend },
    ]);
    expect([...keys.keys()].sort()).toEqual([chatId, other].sort());
    expect(keys.get(other)?.key.equals(otherKey.val.key)).toBe(true);
    // Asked for as the wrong person, a resource is simply absent.
    const asStranger = await openResourceKeys(db, tenantId, 'chat', [
      { resourceId: chatId, subject: stranger },
    ]);
    expect(asStranger.size).toBe(0);
  });

  it('rotating a KEK rewraps what the person holds and retires the old key', async () => {
    const before = await getUserKek(db, tenantId, friend);
    if (!before.ok) throw new Error('kek');
    const rotated = await rotateUserKek(db, tenantId, friend);
    expect(rotated.ok && rotated.val).toEqual({ version: 2, rewrapped: 2 });
    const after = await getUserKek(db, tenantId, friend);
    expect(after.ok && after.val.version).toBe(2);
    expect(after.ok && after.val.key.equals(before.val.key)).toBe(false);
    const reopened = await openResourceKey(db, ref, friend);
    const asOwner = await openResourceKey(db, ref, owner);
    expect(reopened.ok && asOwner.ok && reopened.val.key.equals(asOwner.val.key)).toBe(true);
    const row = await db
      .selectFrom('resource_key_grants')
      .select(['wrapped_key', 'kek_version'])
      .where('subject', '=', friend)
      .where('resource_key_id', '=', reopened.ok ? reopened.val.id : '')
      .executeTakeFirstOrThrow();
    expect(row.kek_version).toBe(2);
    expect(unwrapKey(row.wrapped_key, before.val.key).ok).toBe(false);
  });

  it('a derived KEK matches the primitive given the stored salt', async () => {
    const master = userKeyMaster();
    const row = await db
      .selectFrom('user_encryption_keys')
      .select('salt')
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', owner)
      .executeTakeFirstOrThrow();
    const kek = await getUserKek(db, tenantId, owner);
    expect(
      master.ok &&
        kek.ok &&
        deriveUserKek(master.val, Buffer.from(row.salt, 'base64'), tenantId, owner).equals(
          kek.val.key
        )
    ).toBe(true);
  });

  it('revoking forgets one wrapping and leaves the owner whole', async () => {
    expect(await revokeResourceKey(db, ref, friend)).toBe(true);
    expect(await revokeResourceKey(db, ref, friend)).toBe(false);
    expect(await openResourceKey(db, ref, friend)).toMatchObject({
      ok: false,
      err: { type: 'NO_ACCESS' },
    });
    expect((await openResourceKey(db, ref, owner)).ok).toBe(true);
  });

  it('seals a person-only value under their KEK and still opens legacy envelopes', async () => {
    const legacyKey = randomBytes(32);
    const sealed = await sealForSubject(db, tenantId, stranger, 'secret-token');
    expect(sealed.ok && sealed.val.startsWith('uenc1:')).toBe(true);
    if (!sealed.ok) return;
    const opened = await openForSubject(db, tenantId, stranger, sealed.val, legacyKey);
    expect(opened.ok && opened.val).toBe('secret-token');
    expect((await openForSubject(db, tenantId, owner, sealed.val, legacyKey)).ok).toBe(false);
    const { encrypt } = await import('@renkei/crypto');
    const legacy = await openForSubject(
      db,
      tenantId,
      stranger,
      encrypt('old', legacyKey),
      legacyKey
    );
    expect(legacy.ok && legacy.val).toBe('old');
    expect((await openForSubject(db, tenantId, stranger, encrypt('old', legacyKey), null)).ok).toBe(
      false
    );
  });

  it('shredding a salt makes everything that person held unopenable', async () => {
    await ensureUserKek(db, tenantId, stranger);
    const shared = await shareResourceKey(db, ref, owner, stranger);
    expect(shared.ok).toBe(true);
    expect((await openResourceKey(db, ref, stranger)).ok).toBe(true);
    expect(await shredUserKek(db, tenantId, stranger)).toBe(true);
    expect(await openResourceKey(db, ref, stranger)).toMatchObject({
      ok: false,
      err: { type: 'NO_ACCESS' },
    });
    expect((await openResourceKey(db, ref, owner)).ok).toBe(true);
  });

  it('deleting the key removes every wrapping; the prune catches a key whose chat is gone', async () => {
    await deleteResourceKey(db, ref);
    expect(await openResourceKey(db, ref, owner)).toMatchObject({
      ok: false,
      err: { type: 'NO_KEY' },
    });
    expect(await listResourceKeyHolders(db, ref)).toEqual([]);

    const orphan = randomUUID();
    await db
      .insertInto('chats')
      .values({ id: orphan, tenant_id: tenantId, owner_subject: owner })
      .execute();
    const key = await createResourceKey(db, { ...ref, resourceId: orphan }, owner);
    expect(key.ok).toBe(true);
    await db.deleteFrom('chats').where('id', '=', orphan).execute();
    expect(await pruneOrphanChatKeys(db)).toBeGreaterThanOrEqual(1);
    expect(await openResourceKey(db, { ...ref, resourceId: orphan }, owner)).toMatchObject({
      ok: false,
      err: { type: 'NO_KEY' },
    });
  });
});
