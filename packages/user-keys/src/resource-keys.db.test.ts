/**
 * Held keys against a real database (skipped without DATABASE_URL). A
 * person enrolls as their browser would; from then on nothing is derived:
 * a chat's key opens for its owner through the user key their session
 * delegated, a share seals the key to the grantee's public key and opens
 * for them with nobody else present, an automation delegation alone opens
 * only what was wrapped for it, rotation moves everything to a new user
 * key, a person from before enrolls with their rows moved, and a shred
 * leaves nothing of theirs openable.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import {
  decryptWithResourceKey,
  encryptWithResourceKey,
  sealToPublicKey,
  wrapKey,
} from '@renkei/crypto';
import {
  createResourceKey,
  deleteResourceKey,
  ensureResourceKey,
  grantAutomationAccess,
  listResourceKeyHolders,
  openResourceKey,
  openResourceKeys,
  pruneOrphanResourceKeys,
  revokeResourceKey,
  shareResourceKey,
  wrapResourceKeyUnder,
} from './resource-keys';
import { delegationStatus, getKeyRing, liveInstances } from './keyring';
import {
  enroll,
  enrollmentCensus,
  revokeAutomation,
  rotateUserKey,
  shredUserKey,
} from './enrollment';
import { openForSubject, sealForSubject } from './user-sealed';
import { legacyEnsureResourceKey, legacySealForSubject } from './legacy';
import { setKeyVault } from './vault';
import {
  delegateTestSession,
  enrollTestPerson,
  ensureSession,
  generateBrowserKeys,
  registerTestInstance,
  sealDelegations,
  type BrowserKeys,
  type TestInstance,
} from './test-support/enroll';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('held keys and the resource key store', () => {
  let db: Kysely<DB>;
  let instance: TestInstance;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const friend = `friend-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const projectId = randomUUID();
  const projectChatId = randomUUID();
  const ref = { kind: 'chat' as const, resourceId: chatId };
  const projectRef = { kind: 'chat_project' as const, resourceId: projectId };
  const projectChatRef = { kind: 'chat' as const, resourceId: projectChatId };
  let ownerKeys: BrowserKeys;
  let ownerSession: string;
  let friendKeys: BrowserKeys;
  const targets = () => [{ id: instance.id, publicKey: instance.pair.publicKey }];

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `keys-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('chats')
      .values([
        { id: chatId, owner_subject: owner },
        { id: projectChatId, owner_subject: owner },
      ])
      .execute();
    await db
      .insertInto('chat_projects')
      .values({ id: projectId, owner_subject: owner, name: 'P' })
      .execute();
    instance = await registerTestInstance(db);
    const enrolledOwner = await enrollTestPerson(db, {
      subject: owner,
      instances: targets(),
    });
    ownerKeys = enrolledOwner.keys;
    ownerSession = enrolledOwner.sessionId;
    friendKeys = (await enrollTestPerson(db, { subject: friend, instances: targets() }))
      .keys;
  });

  afterAll(async () => {
    setKeyVault(null);
    await db.deleteFrom('delegate_instances').where('id', '=', instance.id).execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('enrolls: the row holds only wrapped keys and a public key, and the ring opens from the delegation', async () => {
    const row = await db
      .selectFrom('user_encryption_keys')
      .selectAll()
      .where('subject', '=', owner)
      .executeTakeFirstOrThrow();
    expect(row.mode).toBe('held');
    expect(row.public_key).toBe(ownerKeys.pair.publicKey.toString('base64'));
    expect(row.wrapped_private_key).not.toContain(ownerKeys.pair.privateKey.toString('base64'));
    expect(row.wrapped_automation_key).not.toContain(ownerKeys.automationKey.toString('base64'));
    const ring = await getKeyRing(db, tenantId, owner);
    expect(ring.ok && ring.val.scope).toBe('session');
    expect(ring.ok && ring.val.userKey?.equals(ownerKeys.userKey)).toBe(true);
    expect(ring.ok && ring.val.automationKey.equals(ownerKeys.automationKey)).toBe(true);
    expect(ring.ok && ring.val.privateKey()?.equals(ownerKeys.pair.privateKey)).toBe(true);
    expect((await liveInstances(db)).map((live) => live.id)).toContain(instance.id);
    const status = await delegationStatus(db, tenantId, owner);
    expect(status.enrolled).toBe(true);
    expect(status.sessionInstances).toEqual([instance.id]);
    expect(status.automationInstances).toEqual([instance.id]);
    expect(status.automationUntil && status.automationUntil.getTime() > Date.now()).toBe(true);
    expect((await getKeyRing(db, tenantId, stranger)).ok).toBe(false);
  });

  it('refuses an enrollment whose wrappings do not match the delegated key', async () => {
    const keys = generateBrowserKeys();
    const other = generateBrowserKeys();
    const sessionId = await ensureSession(db, tenantId, stranger);
    const sealed = sealDelegations(keys, { instances: targets() });
    const mismatched = await enroll(db, {
      subject: stranger,
      sessionId,
      publicKey: keys.pair.publicKey.toString('base64'),
      wrappedPrivateKey: wrapKey(keys.pair.privateKey, other.userKey),
      wrappedAutomationKey: wrapKey(keys.automationKey, keys.userKey),
      session: sealed.session,
      automation: sealed.automation,
      automationUntil: null,
    });
    expect(!mismatched.ok && mismatched.err.type).toBe('KEY_MISMATCH');
    const elsewhere = await enroll(db, {
      subject: stranger,
      sessionId,
      publicKey: keys.pair.publicKey.toString('base64'),
      wrappedPrivateKey: wrapKey(keys.pair.privateKey, keys.userKey),
      wrappedAutomationKey: wrapKey(keys.automationKey, keys.userKey),
      session: [{ instanceId: randomUUID(), sealedKey: sealed.session[0].sealedKey }],
      automation: [],
      automationUntil: null,
    });
    expect(!elsewhere.ok && elsewhere.err.type).toBe('BAD_DELEGATION');
    expect((await delegationStatus(db, tenantId, stranger)).enrolled).toBe(false);
  });

  it('mints a key for the owner, and nobody else can open it', async () => {
    const created = await createResourceKey(db, ref, owner);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.val.key.byteLength).toBe(32);
    const sealed = encryptWithResourceKey('hello', created.val.id, created.val.key);
    const asOwner = await openResourceKey(db, ref, owner);
    expect(asOwner.ok && asOwner.val.id).toBe(created.val.id);
    expect(asOwner.ok && decryptWithResourceKey(sealed, asOwner.val.id, asOwner.val.key).ok).toBe(
      true
    );
    const asFriend = await openResourceKey(db, ref, friend);
    expect(!asFriend.ok && asFriend.err.type).toBe('NO_ACCESS');
    const asStranger = await openResourceKey(db, ref, stranger);
    expect(!asStranger.ok && asStranger.err.type).toBe('NO_ACCESS');
    const holders = await listResourceKeyHolders(db, ref);
    expect(holders).toEqual([
      expect.objectContaining({ holderKind: 'user', holder: owner, grantedBy: null }),
    ]);
  });

  it('creating again hands back the key that already exists', async () => {
    const first = await openResourceKey(db, ref, owner);
    const again = await createResourceKey(db, ref, owner);
    expect(first.ok && again.ok && again.val.key.equals(first.val.key)).toBe(true);
    const ensured = await ensureResourceKey(db, ref, owner);
    expect(first.ok && ensured.ok && ensured.val.key.equals(first.val.key)).toBe(true);
  });

  it('sharing seals the key to the grantee’s public key; their first open turns it into their own wrapping', async () => {
    const shared = await shareResourceKey(db, ref, owner, friend);
    expect(shared.ok).toBe(true);
    let holders = await listResourceKeyHolders(db, ref);
    expect(holders.find((holder) => holder.holder === friend)?.holderKind).toBe('public');
    const asOwner = await openResourceKey(db, ref, owner);
    const asFriend = await openResourceKey(db, ref, friend);
    expect(asOwner.ok && asFriend.ok && asFriend.val.key.equals(asOwner.val.key)).toBe(true);
    holders = await listResourceKeyHolders(db, ref);
    expect(holders.find((holder) => holder.holder === friend)?.holderKind).toBe('user');
    expect(holders.filter((holder) => holder.holder === friend)).toHaveLength(1);
    // A grantee who has not enrolled has no public key to seal to.
    const toStranger = await shareResourceKey(db, ref, owner, stranger);
    expect(!toStranger.ok && toStranger.err.type).toBe('GRANTEE_NOT_ENROLLED');
  });

  it('only someone holding the key can share it', async () => {
    const byStranger = await shareResourceKey(db, ref, stranger, friend);
    expect(!byStranger.ok && byStranger.err.type).toBe('NO_ACCESS');
  });

  it('opens many at once, each as a named person', async () => {
    const otherChat = randomUUID();
    await db
      .insertInto('chats')
      .values({ id: otherChat, owner_subject: friend })
      .execute();
    const friends = await createResourceKey(db, { ...ref, resourceId: otherChat }, friend);
    expect(friends.ok).toBe(true);
    const opened = await openResourceKeys(db, tenantId, 'chat', [
      { resourceId: chatId, subject: friend },
      { resourceId: otherChat, subject: friend },
      { resourceId: otherChat, subject: owner },
      { resourceId: randomUUID(), subject: owner },
    ]);
    expect(opened.has(chatId)).toBe(true);
    expect(opened.has(otherChat)).toBe(true);
    expect(opened.size).toBe(2);
  });

  it('an automation delegation alone opens what was wrapped for it and nothing else', async () => {
    // The person signs out: their session delegation goes with the session.
    await db.deleteFrom('sessions').where('id', '=', ownerSession).execute();
    const ring = await getKeyRing(db, tenantId, owner);
    expect(ring.ok && ring.val.scope).toBe('automation');
    expect(ring.ok && ring.val.userKey).toBeNull();
    const closed = await openResourceKey(db, ref, owner);
    expect(!closed.ok && closed.err.type).toBe('NEEDS_SESSION');
    const sessionOnly = await getKeyRing(db, tenantId, owner, 'session');
    expect(!sessionOnly.ok && sessionOnly.err.type).toBe('NEEDS_SESSION');
    // An agent minting a chat for them while they are away wraps under the automation key.
    const agentChat = randomUUID();
    await db
      .insertInto('chats')
      .values({ id: agentChat, owner_subject: owner })
      .execute();
    const minted = await createResourceKey(db, { ...ref, resourceId: agentChat }, owner);
    expect(minted.ok).toBe(true);
    expect(
      (await listResourceKeyHolders(db, { ...ref, resourceId: agentChat })).map((h) => h.holderKind)
    ).toEqual(['automation']);
    // Back at the keyboard: a new session opens the agent's chat through the automation key too.
    ownerSession = await delegateTestSession(db, {
      subject: owner,
      keys: ownerKeys,
      instances: targets(),
    });
    const back = await getKeyRing(db, tenantId, owner);
    expect(back.ok && back.val.scope).toBe('session');
    const reopened = await openResourceKey(db, { ...ref, resourceId: agentChat }, owner);
    expect(minted.ok && reopened.ok && reopened.val.key.equals(minted.val.key)).toBe(true);
    // And can let agents at the plain chat, which then opens under automation alone.
    expect((await grantAutomationAccess(db, ref, owner)).ok).toBe(true);
    await db.deleteFrom('sessions').where('id', '=', ownerSession).execute();
    const viaAutomation = await openResourceKey(db, ref, owner);
    expect(viaAutomation.ok).toBe(true);
    ownerSession = await delegateTestSession(db, {
      subject: owner,
      keys: ownerKeys,
      instances: targets(),
    });
  });

  it('a chat’s key under its project’s opens for whoever opens the project', async () => {
    expect((await createResourceKey(db, projectRef, owner)).ok).toBe(true);
    expect((await createResourceKey(db, projectChatRef, owner)).ok).toBe(true);
    expect((await wrapResourceKeyUnder(db, projectChatRef, owner, projectRef)).ok).toBe(true);
    const beforeShare = await openResourceKey(db, projectChatRef, friend);
    expect(!beforeShare.ok && beforeShare.err.type).toBe('NO_ACCESS');
    expect((await shareResourceKey(db, projectRef, owner, friend)).ok).toBe(true);
    const asFriend = await openResourceKey(db, projectChatRef, friend);
    const asOwner = await openResourceKey(db, projectChatRef, owner);
    expect(asFriend.ok && asOwner.ok && asFriend.val.key.equals(asOwner.val.key)).toBe(true);
    const many = await openResourceKeys(db, tenantId, 'chat', [
      { resourceId: projectChatId, subject: friend },
    ]);
    expect(many.has(projectChatId)).toBe(true);
  });

  it('seals a person-only value under the key its scope names', async () => {
    const credential = await sealForSubject(db, tenantId, owner, 'oauth-token');
    const memory = await sealForSubject(db, tenantId, owner, 'likes short answers', 'session');
    expect(credential.ok && credential.val.startsWith('uenc1:')).toBe(true);
    expect(memory.ok && memory.val.startsWith('upriv1:')).toBe(true);
    if (!credential.ok || !memory.ok) return;
    expect((await openForSubject(db, tenantId, owner, credential.val)).ok).toBe(true);
    expect((await openForSubject(db, tenantId, owner, memory.val)).ok).toBe(true);
    const wrongPerson = await openForSubject(db, tenantId, friend, credential.val);
    expect(!wrongPerson.ok && wrongPerson.err.type).toBe('DECRYPTION_ERROR');
    // Away: the credential still opens (automation), the memory does not (session only).
    await db.deleteFrom('sessions').where('id', '=', ownerSession).execute();
    expect((await openForSubject(db, tenantId, owner, credential.val)).ok).toBe(true);
    const away = await openForSubject(db, tenantId, owner, memory.val);
    expect(!away.ok && away.err.type).toBe('NEEDS_SESSION');
    const sealAway = await sealForSubject(db, tenantId, owner, 'x', 'session');
    expect(!sealAway.ok && sealAway.err.type).toBe('NEEDS_SESSION');
    ownerSession = await delegateTestSession(db, {
      subject: owner,
      keys: ownerKeys,
      instances: targets(),
    });
  });

  it('revoking automation pauses unattended work until the next sign-in', async () => {
    expect(await revokeAutomation(db, tenantId, friend)).toBe(1);
    const status = await delegationStatus(db, tenantId, friend);
    expect(status.automationInstances).toEqual([]);
    expect(status.sessionInstances).toEqual([instance.id]);
    const friendSession = await db
      .selectFrom('key_delegations')
      .select('session_id')
      .where('subject', '=', friend)
      .executeTakeFirstOrThrow();
    await db
      .deleteFrom('sessions')
      .where('id', '=', friendSession.session_id ?? '')
      .execute();
    const away = await getKeyRing(db, tenantId, friend);
    expect(!away.ok && away.err.type).toBe('NEEDS_DELEGATION');
    await delegateTestSession(db, {
      subject: friend,
      keys: friendKeys,
      instances: targets(),
    });
  });

  it('rotating the user key moves every wrapping and value; the old key opens nothing', async () => {
    const before = await openResourceKey(db, ref, owner);
    const memory = await sealForSubject(db, tenantId, owner, 'remember this', 'session');
    expect(before.ok && memory.ok).toBe(true);
    if (!before.ok || !memory.ok) return;
    await db
      .insertInto('chat_user_memories')
      .values({ owner_subject: owner, kind: 'entry', content: memory.val })
      .execute();
    const next: BrowserKeys = { ...ownerKeys, userKey: randomBytes(32) };
    const sealed = sealDelegations(next, { instances: targets() });
    const rotated = await rotateUserKey(db, {
      subject: owner,
      sessionId: ownerSession,
      wrappedPrivateKey: wrapKey(next.pair.privateKey, next.userKey),
      wrappedAutomationKey: wrapKey(next.automationKey, next.userKey),
      session: sealed.session,
      automation: sealed.automation,
      automationUntil: null,
    });
    expect(rotated.ok).toBe(true);
    ownerKeys = next;
    const after = await openResourceKey(db, ref, owner);
    expect(after.ok && after.val.key.equals(before.val.key)).toBe(true);
    const stored = await db
      .selectFrom('chat_user_memories')
      .select('content')
      .where('owner_subject', '=', owner)
      .executeTakeFirstOrThrow();
    expect(stored.content).not.toBe(memory.val);
    const reopened = await openForSubject(db, tenantId, owner, stored.content);
    expect(reopened.ok && reopened.val).toBe('remember this');
    // A rotation with the automation key swapped is refused: that key is not what rotates.
    const swapped = { ...next, automationKey: randomBytes(32) };
    const sealedSwapped = sealDelegations(swapped, { instances: targets() });
    const refused = await rotateUserKey(db, {
      subject: owner,
      sessionId: ownerSession,
      wrappedPrivateKey: wrapKey(swapped.pair.privateKey, swapped.userKey),
      wrappedAutomationKey: wrapKey(swapped.automationKey, swapped.userKey),
      session: sealedSwapped.session,
      automation: sealedSwapped.automation,
      automationUntil: null,
    });
    expect(!refused.ok && refused.err.type).toBe('KEY_MISMATCH');
  });

  it('revoking forgets one wrapping and leaves the owner whole', async () => {
    expect(await revokeResourceKey(db, ref, friend)).toBe(true);
    const asFriend = await openResourceKey(db, ref, friend);
    expect(!asFriend.ok && asFriend.err.type).toBe('NO_ACCESS');
    expect((await openResourceKey(db, ref, owner)).ok).toBe(true);
    expect(await revokeResourceKey(db, ref, friend)).toBe(false);
  });

  it('a person from before enrolls with everything moved off the managed key', async () => {
    process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const legacyChat = randomUUID();
    const legacy = `legacy-${tenantId.slice(0, 8)}`;
    await db
      .insertInto('chats')
      .values({ id: legacyChat, owner_subject: legacy })
      .execute();
    const legacyRef = { kind: 'chat' as const, resourceId: legacyChat };
    const key = await legacyEnsureResourceKey(db, legacyRef, legacy);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const token = await legacySealForSubject(db, tenantId, legacy, 'tok');
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    await db
      .insertInto('provider_grants')
      .values({
        provider: 'atlassian',
        provider_account_id: 'acct',
        subject: legacy,
        client_id: 'c',
        display_name: 'L',
        encrypted_access_token: token.val,
        encrypted_refresh_token: token.val,
        expires_at: new Date(),
        requested_scopes: [],
        granted_scopes: [],
        metadata: '{}',
      })
      .execute();
    const beforeEnroll = await getKeyRing(db, tenantId, legacy);
    expect(!beforeEnroll.ok && beforeEnroll.err.type).toBe('NOT_ENROLLED');
    expect((await delegationStatus(db, tenantId, legacy)).legacy).toBe(true);
    expect(await enrollmentCensus(db, tenantId)).toEqual(expect.objectContaining({ managed: 1 }));
    await enrollTestPerson(db, { subject: legacy, instances: targets() });
    const opened = await openResourceKey(db, legacyRef, legacy);
    expect(opened.ok && opened.val.key.equals(key.val.key)).toBe(true);
    const grant = await db
      .selectFrom('provider_grants')
      .select('encrypted_access_token')
      .where('subject', '=', legacy)
      .executeTakeFirstOrThrow();
    expect(grant.encrypted_access_token).not.toBe(token.val);
    const reopened = await openForSubject(db, tenantId, legacy, grant.encrypted_access_token);
    expect(reopened.ok && reopened.val).toBe('tok');
    expect((await enrollmentCensus(db, tenantId)).managed).toBe(0);
  });

  it('shredding leaves nothing of the person openable', async () => {
    const chat = await openResourceKey(db, ref, owner);
    expect(chat.ok).toBe(true);
    expect(await shredUserKey(db, tenantId, owner)).toBe(true);
    const gone = await getKeyRing(db, tenantId, owner);
    expect(!gone.ok && gone.err.type).toBe('NO_USER_KEY');
    expect(await listResourceKeyHolders(db, ref)).toEqual([]);
    expect(
      await db.selectFrom('key_delegations').select('id').where('subject', '=', owner).execute()
    ).toEqual([]);
    // A box sealed to a shredded person's public key would be inert anyway; none is left.
    expect(sealToPublicKey(ownerKeys.pair.publicKey, randomBytes(32)).startsWith('sbox1:')).toBe(
      true
    );
  });

  it('deleting the key removes every wrapping; the prune catches a key whose chat is gone', async () => {
    await deleteResourceKey(db, projectChatRef);
    expect(await listResourceKeyHolders(db, projectChatRef)).toEqual([]);
    const orphan = randomUUID();
    await db
      .insertInto('resource_keys')
      .values({ resource_kind: 'chat', resource_id: orphan })
      .execute();
    expect(await pruneOrphanResourceKeys(db)).toBeGreaterThanOrEqual(1);
  });
});
