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
import { getDataStore } from '@renkei/db';
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
  let instance: TestInstance;
  const suiteId = randomUUID();
  const owner = `owner-${suiteId.slice(0, 8)}`;
  const friend = `friend-${suiteId.slice(0, 8)}`;
  const stranger = `stranger-${suiteId.slice(0, 8)}`;
  let chatId = '';
  let projectId = '';
  let projectChatId = '';
  let ref = { kind: 'chat' as const, resourceId: '' };
  let projectRef = { kind: 'chat_project' as const, resourceId: '' };
  let projectChatRef = { kind: 'chat' as const, resourceId: '' };
  let ownerKeys: BrowserKeys;
  let ownerSession: string;
  let friendKeys: BrowserKeys;
  let friendSession: string;
  const targets = () => [{ id: instance.id, publicKey: instance.pair.publicKey }];

  /** A new chat the way the chat page starts one. */
  async function newChat(ownerSubject: string): Promise<string> {
    return getDataStore().chats.create({
      ownerSubject,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
  }

  /** The person signs out: their session delegation goes with the session. */
  async function signOut(sessionId: string): Promise<void> {
    await getDataStore().sessions.delete(sessionId);
  }

  beforeAll(async () => {
    chatId = await newChat(owner);
    projectChatId = await newChat(owner);
    projectId = await getDataStore().chatProjects.create({
      ownerSubject: owner,
      name: 'P',
      description: null,
      toolConfig: null,
    });
    ref = { kind: 'chat', resourceId: chatId };
    projectRef = { kind: 'chat_project', resourceId: projectId };
    projectChatRef = { kind: 'chat', resourceId: projectChatId };
    instance = await registerTestInstance();
    const enrolledOwner = await enrollTestPerson({
      subject: owner,
      instances: targets(),
    });
    ownerKeys = enrolledOwner.keys;
    ownerSession = enrolledOwner.sessionId;
    const enrolledFriend = await enrollTestPerson({ subject: friend, instances: targets() });
    friendKeys = enrolledFriend.keys;
    friendSession = enrolledFriend.sessionId;
  });

  afterAll(async () => {
    setKeyVault(null);
    await getDataStore().userKeys.deleteInstance(instance.id);
  });

  it('enrolls: the row holds only wrapped keys and a public key, and the ring opens from the delegation', async () => {
    const row = await getDataStore().userKeys.findKeyRow(owner);
    if (!row) throw new Error('no key row');
    expect(row.mode).toBe('held');
    expect(row.publicKey).toBe(ownerKeys.pair.publicKey.toString('base64'));
    expect(row.wrappedPrivateKey).not.toContain(ownerKeys.pair.privateKey.toString('base64'));
    expect(row.wrappedAutomationKey).not.toContain(ownerKeys.automationKey.toString('base64'));
    const ring = await getKeyRing(owner);
    expect(ring.ok && ring.val.scope).toBe('session');
    expect(ring.ok && ring.val.userKey?.equals(ownerKeys.userKey)).toBe(true);
    expect(ring.ok && ring.val.automationKey.equals(ownerKeys.automationKey)).toBe(true);
    expect(ring.ok && ring.val.privateKey()?.equals(ownerKeys.pair.privateKey)).toBe(true);
    expect((await liveInstances()).map((live) => live.id)).toContain(instance.id);
    const status = await delegationStatus(owner);
    expect(status.enrolled).toBe(true);
    expect(status.sessionInstances).toEqual([instance.id]);
    expect(status.automationInstances).toEqual([instance.id]);
    expect(status.automationUntil && status.automationUntil.getTime() > Date.now()).toBe(true);
    expect((await getKeyRing(stranger)).ok).toBe(false);
  });

  it('refuses an enrollment whose wrappings do not match the delegated key', async () => {
    const keys = generateBrowserKeys();
    const other = generateBrowserKeys();
    const sessionId = await ensureSession(stranger);
    const sealed = sealDelegations(keys, { instances: targets() });
    const mismatched = await enroll({
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
    const elsewhere = await enroll({
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
    expect((await delegationStatus(stranger)).enrolled).toBe(false);
  });

  it('mints a key for the owner, and nobody else can open it', async () => {
    const created = await createResourceKey(ref, owner);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.val.key.byteLength).toBe(32);
    const sealed = encryptWithResourceKey('hello', created.val.id, created.val.key);
    const asOwner = await openResourceKey(ref, owner);
    expect(asOwner.ok && asOwner.val.id).toBe(created.val.id);
    expect(asOwner.ok && decryptWithResourceKey(sealed, asOwner.val.id, asOwner.val.key).ok).toBe(
      true
    );
    const asFriend = await openResourceKey(ref, friend);
    expect(!asFriend.ok && asFriend.err.type).toBe('NO_ACCESS');
    const asStranger = await openResourceKey(ref, stranger);
    expect(!asStranger.ok && asStranger.err.type).toBe('NO_ACCESS');
    const holders = await listResourceKeyHolders(ref);
    expect(holders).toEqual([
      expect.objectContaining({ holderKind: 'user', holder: owner, grantedBy: null }),
    ]);
  });

  it('creating again hands back the key that already exists', async () => {
    const first = await openResourceKey(ref, owner);
    const again = await createResourceKey(ref, owner);
    expect(first.ok && again.ok && again.val.key.equals(first.val.key)).toBe(true);
    const ensured = await ensureResourceKey(ref, owner);
    expect(first.ok && ensured.ok && ensured.val.key.equals(first.val.key)).toBe(true);
  });

  it('sharing seals the key to the grantee’s public key; their first open turns it into their own wrapping', async () => {
    const shared = await shareResourceKey(ref, owner, friend);
    expect(shared.ok).toBe(true);
    let holders = await listResourceKeyHolders(ref);
    expect(holders.find((holder) => holder.holder === friend)?.holderKind).toBe('public');
    const asOwner = await openResourceKey(ref, owner);
    const asFriend = await openResourceKey(ref, friend);
    expect(asOwner.ok && asFriend.ok && asFriend.val.key.equals(asOwner.val.key)).toBe(true);
    holders = await listResourceKeyHolders(ref);
    expect(holders.find((holder) => holder.holder === friend)?.holderKind).toBe('user');
    expect(holders.filter((holder) => holder.holder === friend)).toHaveLength(1);
    // A grantee who has not enrolled has no public key to seal to.
    const toStranger = await shareResourceKey(ref, owner, stranger);
    expect(!toStranger.ok && toStranger.err.type).toBe('GRANTEE_NOT_ENROLLED');
  });

  it('only someone holding the key can share it', async () => {
    const byStranger = await shareResourceKey(ref, stranger, friend);
    expect(!byStranger.ok && byStranger.err.type).toBe('NO_ACCESS');
  });

  it('opens many at once, each as a named person', async () => {
    const otherChat = await newChat(friend);
    const friends = await createResourceKey({ ...ref, resourceId: otherChat }, friend);
    expect(friends.ok).toBe(true);
    const opened = await openResourceKeys('chat', [
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
    await signOut(ownerSession);
    const ring = await getKeyRing(owner);
    expect(ring.ok && ring.val.scope).toBe('automation');
    expect(ring.ok && ring.val.userKey).toBeNull();
    const closed = await openResourceKey(ref, owner);
    expect(!closed.ok && closed.err.type).toBe('NEEDS_SESSION');
    const sessionOnly = await getKeyRing(owner, 'session');
    expect(!sessionOnly.ok && sessionOnly.err.type).toBe('NEEDS_SESSION');
    // An agent minting a chat for them while they are away wraps under the automation key.
    const agentChat = await newChat(owner);
    const minted = await createResourceKey({ ...ref, resourceId: agentChat }, owner);
    expect(minted.ok).toBe(true);
    expect(
      (await listResourceKeyHolders({ ...ref, resourceId: agentChat })).map((h) => h.holderKind)
    ).toEqual(['automation']);
    // Back at the keyboard: a new session opens the agent's chat through the automation key too.
    ownerSession = await delegateTestSession({
      subject: owner,
      keys: ownerKeys,
      instances: targets(),
    });
    const back = await getKeyRing(owner);
    expect(back.ok && back.val.scope).toBe('session');
    const reopened = await openResourceKey({ ...ref, resourceId: agentChat }, owner);
    expect(minted.ok && reopened.ok && reopened.val.key.equals(minted.val.key)).toBe(true);
    // And can let agents at the plain chat, which then opens under automation alone.
    expect((await grantAutomationAccess(ref, owner)).ok).toBe(true);
    await signOut(ownerSession);
    const viaAutomation = await openResourceKey(ref, owner);
    expect(viaAutomation.ok).toBe(true);
    ownerSession = await delegateTestSession({
      subject: owner,
      keys: ownerKeys,
      instances: targets(),
    });
  });

  it('a chat’s key under its project’s opens for whoever opens the project', async () => {
    expect((await createResourceKey(projectRef, owner)).ok).toBe(true);
    expect((await createResourceKey(projectChatRef, owner)).ok).toBe(true);
    expect((await wrapResourceKeyUnder(projectChatRef, owner, projectRef)).ok).toBe(true);
    const beforeShare = await openResourceKey(projectChatRef, friend);
    expect(!beforeShare.ok && beforeShare.err.type).toBe('NO_ACCESS');
    expect((await shareResourceKey(projectRef, owner, friend)).ok).toBe(true);
    const asFriend = await openResourceKey(projectChatRef, friend);
    const asOwner = await openResourceKey(projectChatRef, owner);
    expect(asFriend.ok && asOwner.ok && asFriend.val.key.equals(asOwner.val.key)).toBe(true);
    const many = await openResourceKeys('chat', [{ resourceId: projectChatId, subject: friend }]);
    expect(many.has(projectChatId)).toBe(true);
  });

  it('seals a person-only value under the key its scope names', async () => {
    const credential = await sealForSubject(owner, 'oauth-token');
    const memory = await sealForSubject(owner, 'likes short answers', 'session');
    expect(credential.ok && credential.val.startsWith('uenc1:')).toBe(true);
    expect(memory.ok && memory.val.startsWith('upriv1:')).toBe(true);
    if (!credential.ok || !memory.ok) return;
    expect((await openForSubject(owner, credential.val)).ok).toBe(true);
    expect((await openForSubject(owner, memory.val)).ok).toBe(true);
    const wrongPerson = await openForSubject(friend, credential.val);
    expect(!wrongPerson.ok && wrongPerson.err.type).toBe('DECRYPTION_ERROR');
    // Away: the credential still opens (automation), the memory does not (session only).
    await signOut(ownerSession);
    expect((await openForSubject(owner, credential.val)).ok).toBe(true);
    const away = await openForSubject(owner, memory.val);
    expect(!away.ok && away.err.type).toBe('NEEDS_SESSION');
    const sealAway = await sealForSubject(owner, 'x', 'session');
    expect(!sealAway.ok && sealAway.err.type).toBe('NEEDS_SESSION');
    ownerSession = await delegateTestSession({
      subject: owner,
      keys: ownerKeys,
      instances: targets(),
    });
  });

  it('revoking automation pauses unattended work until the next sign-in', async () => {
    expect(await revokeAutomation(friend)).toBe(1);
    const status = await delegationStatus(friend);
    expect(status.automationInstances).toEqual([]);
    expect(status.sessionInstances).toEqual([instance.id]);
    await signOut(friendSession);
    const away = await getKeyRing(friend);
    expect(!away.ok && away.err.type).toBe('NEEDS_DELEGATION');
    await delegateTestSession({
      subject: friend,
      keys: friendKeys,
      instances: targets(),
    });
  });

  it('rotating the user key moves every wrapping and value; the old key opens nothing', async () => {
    const before = await openResourceKey(ref, owner);
    const memory = await sealForSubject(owner, 'remember this', 'session');
    expect(before.ok && memory.ok).toBe(true);
    if (!before.ok || !memory.ok) return;
    await getDataStore().userMemory.append({
      ownerSubject: owner,
      content: memory.val,
      chatId: null,
      keep: 50,
    });
    const next: BrowserKeys = { ...ownerKeys, userKey: randomBytes(32) };
    const sealed = sealDelegations(next, { instances: targets() });
    const rotated = await rotateUserKey({
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
    const after = await openResourceKey(ref, owner);
    expect(after.ok && after.val.key.equals(before.val.key)).toBe(true);
    const [stored] = await getDataStore().userMemory.list(owner, 1);
    if (!stored) throw new Error('memory entry gone');
    expect(stored.content).not.toBe(memory.val);
    const reopened = await openForSubject(owner, stored.content);
    expect(reopened.ok && reopened.val).toBe('remember this');
    // A rotation with the automation key swapped is refused: that key is not what rotates.
    const swapped = { ...next, automationKey: randomBytes(32) };
    const sealedSwapped = sealDelegations(swapped, { instances: targets() });
    const refused = await rotateUserKey({
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
    expect(await revokeResourceKey(ref, friend)).toBe(true);
    const asFriend = await openResourceKey(ref, friend);
    expect(!asFriend.ok && asFriend.err.type).toBe('NO_ACCESS');
    expect((await openResourceKey(ref, owner)).ok).toBe(true);
    expect(await revokeResourceKey(ref, friend)).toBe(false);
  });

  it('a person from before enrolls with everything moved off the managed key', async () => {
    process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const legacy = `legacy-${suiteId.slice(0, 8)}`;
    const legacyChat = await newChat(legacy);
    const legacyRef = { kind: 'chat' as const, resourceId: legacyChat };
    const key = await legacyEnsureResourceKey(legacyRef, legacy);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const token = await legacySealForSubject(legacy, 'tok');
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    // A grant connected back then: its tokens sealed under the managed key.
    await getDataStore().providerGrants.upsertSealed('atlassian', {
      accountId: `acct-${legacy}`,
      clientId: 'c',
      displayName: 'L',
      subject: legacy,
      encryptedAccessToken: token.val,
      encryptedRefreshToken: token.val,
      keepStoredRefreshToken: false,
      expiresAt: new Date(),
      requestedScopes: [],
      grantedScopes: [],
      metadata: {},
    });
    const beforeEnroll = await getKeyRing(legacy);
    expect(!beforeEnroll.ok && beforeEnroll.err.type).toBe('NOT_ENROLLED');
    expect((await delegationStatus(legacy)).legacy).toBe(true);
    expect(await enrollmentCensus()).toEqual(expect.objectContaining({ managed: 1 }));
    await enrollTestPerson({ subject: legacy, instances: targets() });
    const opened = await openResourceKey(legacyRef, legacy);
    expect(opened.ok && opened.val.key.equals(key.val.key)).toBe(true);
    const grant = await getDataStore().providerGrants.findSealed('atlassian', `acct-${legacy}`);
    if (!grant) throw new Error('grant gone');
    expect(grant.encryptedAccessToken).not.toBe(token.val);
    const reopened = await openForSubject(legacy, grant.encryptedAccessToken);
    expect(reopened.ok && reopened.val).toBe('tok');
    expect((await enrollmentCensus()).managed).toBe(0);
  });

  it('shredding leaves nothing of the person openable', async () => {
    const chat = await openResourceKey(ref, owner);
    expect(chat.ok).toBe(true);
    expect(await shredUserKey(owner)).toBe(true);
    const gone = await getKeyRing(owner);
    expect(!gone.ok && gone.err.type).toBe('NO_USER_KEY');
    expect(await listResourceKeyHolders(ref)).toEqual([]);
    expect(await getDataStore().userKeys.delegationsOf(owner, new Date())).toEqual([]);
    // A box sealed to a shredded person's public key would be inert anyway; none is left.
    expect(sealToPublicKey(ownerKeys.pair.publicKey, randomBytes(32)).startsWith('sbox1:')).toBe(
      true
    );
  });

  it('deleting the key removes every wrapping; the prune catches a key whose chat is gone', async () => {
    await deleteResourceKey(projectChatRef);
    expect(await listResourceKeyHolders(projectChatRef)).toEqual([]);
    const orphan = randomUUID();
    // A key minted for a chat that never came to be (or was deleted around it).
    await getDataStore().resourceKeys.insertIfAbsent('chat', orphan);
    expect(await pruneOrphanResourceKeys()).toBeGreaterThanOrEqual(1);
  });
});
