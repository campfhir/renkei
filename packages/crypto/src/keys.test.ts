/**
 * The key hierarchy's pure half: a KEK is a function of (master, salt,
 * identity) and nothing else; a wrapped key opens only under the KEK it
 * was wrapped with; the two envelopes are recognizable and name their
 * keys.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  deriveUserKek,
  generateDataKey,
  generateUserKeySalt,
  wrapKey,
  unwrapKey,
  encryptWithResourceKey,
  decryptWithResourceKey,
  parseResourceEnvelope,
  isResourceEncrypted,
  sealForUser,
  openForUser,
  isUserSealed,
  userKeyMaster,
  RESOURCE_ENVELOPE_PREFIX,
} from './keys';
import { isEncryptedContent } from './content';

const master = randomBytes(32);

describe('deriveUserKek', () => {
  it('is deterministic for one identity and distinct across people, tenants and salts', () => {
    const salt = generateUserKeySalt();
    const a = deriveUserKek(master, salt, 'tenant-1', 'alice');
    expect(a.byteLength).toBe(32);
    expect(deriveUserKek(master, salt, 'tenant-1', 'alice').equals(a)).toBe(true);
    expect(deriveUserKek(master, salt, 'tenant-1', 'bob').equals(a)).toBe(false);
    expect(deriveUserKek(master, salt, 'tenant-2', 'alice').equals(a)).toBe(false);
    expect(deriveUserKek(master, generateUserKeySalt(), 'tenant-1', 'alice').equals(a)).toBe(false);
    expect(deriveUserKek(randomBytes(32), salt, 'tenant-1', 'alice').equals(a)).toBe(false);
  });

  it('does not let a subject spill into the tenant field', () => {
    const salt = generateUserKeySalt();
    // The separator keeps ("ab", "c") and ("a", "bc") apart.
    expect(
      deriveUserKek(master, salt, 'ab', 'c').equals(deriveUserKek(master, salt, 'a', 'bc'))
    ).toBe(false);
  });
});

describe('wrapKey / unwrapKey', () => {
  it('round-trips under the right KEK and refuses the wrong one', () => {
    const kek = deriveUserKek(master, generateUserKeySalt(), 't', 'alice');
    const other = deriveUserKek(master, generateUserKeySalt(), 't', 'bob');
    const dek = generateDataKey();
    const wrapped = wrapKey(dek, kek);
    expect(wrapped).not.toContain(dek.toString('base64'));
    const opened = unwrapKey(wrapped, kek);
    expect(opened.ok && opened.val.equals(dek)).toBe(true);
    expect(unwrapKey(wrapped, other).ok).toBe(false);
  });

  it('rejects an unwrapped value of the wrong length', () => {
    const kek = randomBytes(32);
    const wrapped = wrapKey(randomBytes(16), kek);
    const opened = unwrapKey(wrapped, kek);
    expect(opened.ok).toBe(false);
  });
});

describe('renc2 resource envelope', () => {
  const keyId = randomUUID();
  const key = generateDataKey();

  it('seals, names its key, and opens', () => {
    const stored = encryptWithResourceKey('what was said', keyId, key);
    expect(stored.startsWith(RESOURCE_ENVELOPE_PREFIX)).toBe(true);
    expect(isResourceEncrypted(stored)).toBe(true);
    // Never mistaken for the deployment-key envelope.
    expect(isEncryptedContent(stored)).toBe(false);
    expect(parseResourceEnvelope(stored)).toEqual({
      keyId,
      payload: expect.stringMatching(/^v1\./),
    });
    const opened = decryptWithResourceKey(stored, keyId, key);
    expect(opened.ok && opened.val).toBe('what was said');
  });

  it('says which key a row wants instead of an opaque failure', () => {
    const stored = encryptWithResourceKey('x', keyId, key);
    const wrong = decryptWithResourceKey(stored, randomUUID(), key);
    expect(!wrong.ok && wrong.err.type).toBe('WRONG_KEY');
    const badKey = decryptWithResourceKey(stored, keyId, generateDataKey());
    expect(!badKey.ok && badKey.err.type).toBe('DECRYPTION_ERROR');
    expect(decryptWithResourceKey('renc1:v1.a.b.c', keyId, key).ok).toBe(false);
  });

  it('parses defensively', () => {
    expect(parseResourceEnvelope('renc2:')).toBeNull();
    expect(parseResourceEnvelope('renc2::v1.a.b.c')).toBeNull();
    expect(parseResourceEnvelope('renc2:abc')).toBeNull();
    expect(parseResourceEnvelope('renc2:abc:')).toBeNull();
    expect(parseResourceEnvelope('plain')).toBeNull();
  });
});

describe('uenc1 user envelope', () => {
  it('round-trips under the KEK and is recognizable', () => {
    const kek = randomBytes(32);
    const stored = sealForUser('hunter2', kek);
    expect(isUserSealed(stored)).toBe(true);
    expect(isUserSealed('v1.a.b.c')).toBe(false);
    const opened = openForUser(stored, kek);
    expect(opened.ok && opened.val).toBe('hunter2');
    expect(openForUser(stored, randomBytes(32)).ok).toBe(false);
    expect(openForUser('v1.a.b.c', kek).ok).toBe(false);
  });
});

describe('userKeyMaster', () => {
  const saved = {
    user: process.env.USER_KEY_ENCRYPTION_KEY,
    content: process.env.CONTENT_ENCRYPTION_KEY,
    token: process.env.TOKEN_ENCRYPTION_KEY,
  };
  afterEach(() => {
    for (const [name, value] of [
      ['USER_KEY_ENCRYPTION_KEY', saved.user],
      ['CONTENT_ENCRYPTION_KEY', saved.content],
      ['TOKEN_ENCRYPTION_KEY', saved.token],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('resolves the dedicated key first, then the content chain', () => {
    delete process.env.USER_KEY_ENCRYPTION_KEY;
    delete process.env.CONTENT_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(userKeyMaster().ok).toBe(false);
    const token = randomBytes(32);
    process.env.TOKEN_ENCRYPTION_KEY = token.toString('base64');
    const fromToken = userKeyMaster();
    expect(fromToken.ok && fromToken.val.equals(token)).toBe(true);
    const dedicated = randomBytes(32);
    process.env.USER_KEY_ENCRYPTION_KEY = dedicated.toString('base64');
    const fromDedicated = userKeyMaster();
    expect(fromDedicated.ok && fromDedicated.val.equals(dedicated)).toBe(true);
    process.env.USER_KEY_ENCRYPTION_KEY = 'short';
    expect(userKeyMaster().ok).toBe(false);
  });
});

describe('own-key derivation', () => {
  it('derives from the passphrase alone, distinct from the managed key space', async () => {
    const { deriveOwnKek, deriveUnlockKey, kekVerifier, verifierMatches } = await import('./keys');
    const salt = generateUserKeySalt();
    const a = deriveOwnKek('correct horse battery staple', salt, 't', 'alice');
    expect(a.byteLength).toBe(32);
    expect(deriveOwnKek('correct horse battery staple', salt, 't', 'alice').equals(a)).toBe(true);
    expect(deriveOwnKek('correct horse battery stapl', salt, 't', 'alice').equals(a)).toBe(false);
    expect(deriveOwnKek('correct horse battery staple', salt, 't', 'bob').equals(a)).toBe(false);
    // NFKC: the same passphrase typed in a different normalization form is the same key.
    expect(
      deriveOwnKek('café', salt, 't', 'alice').equals(deriveOwnKek('café', salt, 't', 'alice'))
    ).toBe(true);
    // Not the managed KEK, and not the unlock key either.
    expect(deriveUserKek(master, salt, 't', 'alice').equals(a)).toBe(false);
    expect(
      deriveUnlockKey(master, salt, 't', 'alice').equals(deriveUserKek(master, salt, 't', 'alice'))
    ).toBe(false);

    const verifier = kekVerifier(a);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(verifierMatches(a, verifier)).toBe(true);
    expect(verifierMatches(randomBytes(32), verifier)).toBe(false);
    expect(verifierMatches(a, 'abc')).toBe(false);
  });
});
