/**
 * The two ciphers over the two envelopes: a chat's cipher seals `renc2`
 * and opens both its own rows and the deployment-key rows from before the
 * chat had a key; the legacy cipher opens only those, and names what it
 * cannot open instead of leaking bytes or throwing.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { encryptContent, parseEncryptionKey } from '@renkei/crypto';
import {
  isSealed,
  legacyCipher,
  openBlocks,
  openStoredText,
  openText,
  resourceCipher,
  sealBlocks,
  sealText,
} from './content-crypto';

const contentKey = randomBytes(32);
const saved = {
  content: process.env.CONTENT_ENCRYPTION_KEY,
  token: process.env.TOKEN_ENCRYPTION_KEY,
};

beforeAll(() => {
  process.env.CONTENT_ENCRYPTION_KEY = contentKey.toString('base64');
});
afterAll(() => {
  if (saved.content === undefined) delete process.env.CONTENT_ENCRYPTION_KEY;
  else process.env.CONTENT_ENCRYPTION_KEY = saved.content;
  if (saved.token === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = saved.token;
});

const chatKey = { id: randomUUID(), key: randomBytes(32) };
const otherKey = { id: randomUUID(), key: randomBytes(32) };

describe('resourceCipher', () => {
  const cipher = resourceCipher(chatKey);

  it('seals renc2 under the chat key and opens it', () => {
    const sealed = sealText('hello', cipher);
    expect(sealed.ok && sealed.val.startsWith(`renc2:${chatKey.id}:`)).toBe(true);
    if (!sealed.ok) return;
    expect(openText(sealed.val, cipher)).toBe('hello');
    expect(cipher.keyId).toBe(chatKey.id);
  });

  it('opens a legacy renc1 row from before the chat had a key', () => {
    const legacy = encryptContent('older', contentKey);
    expect(openText(legacy, cipher)).toBe('older');
  });

  it('names a row sealed under another key, and never returns its bytes', () => {
    const foreign = sealText('theirs', resourceCipher(otherKey));
    if (!foreign.ok) throw new Error('seal');
    const shown = openText(foreign.val, cipher);
    expect(shown).toContain('content unavailable');
    expect(shown).toContain('another key');
    expect(shown).not.toContain('theirs');
    // Same id, wrong bytes: an opaque failure.
    const forged = sealText('x', resourceCipher({ id: chatKey.id, key: randomBytes(32) }));
    if (!forged.ok) throw new Error('seal');
    expect(openText(forged.val, cipher)).toBe('[content unavailable: decryption failed]');
  });

  it('round-trips blocks', () => {
    const blocks = [
      { type: 'text' as const, text: 'a' },
      { type: 'tool_use' as const, id: 't1', name: 'jira_get_issue', input: { key: 'OPS-1' } },
    ];
    const sealed = sealBlocks(blocks, cipher);
    if (!sealed.ok) throw new Error('seal');
    expect(openBlocks(sealed.val, cipher)).toEqual(blocks);
  });
});

describe('legacyCipher', () => {
  it('is the default, seals renc1, and refuses renc2 with a marker', () => {
    const sealed = sealText('plain default');
    expect(sealed.ok && sealed.val.startsWith('renc1:')).toBe(true);
    if (!sealed.ok) return;
    expect(openText(sealed.val)).toBe('plain default');
    expect(legacyCipher.keyId).toBeNull();
    const keyed = sealText('keyed', resourceCipher(chatKey));
    if (!keyed.ok) throw new Error('seal');
    expect(openText(keyed.val)).toBe("[content unavailable: this chat's key was not opened]");
    expect(openBlocks(keyed.val)).toEqual([
      { type: 'text', text: "[content unavailable: this chat's key was not opened]" },
    ]);
  });

  it('fails to seal without a content key', () => {
    const key = process.env.CONTENT_ENCRYPTION_KEY;
    delete process.env.CONTENT_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      expect(sealText('x').ok).toBe(false);
      // A keyed cipher needs no deployment key to seal.
      expect(sealText('x', resourceCipher(chatKey)).ok).toBe(true);
    } finally {
      process.env.CONTENT_ENCRYPTION_KEY = key;
    }
  });
});

describe('openStoredText', () => {
  it('opens an envelope and passes through a pre-envelope plaintext column', () => {
    const cipher = resourceCipher(chatKey);
    expect(openStoredText('a plaintext summary', cipher)).toBe('a plaintext summary');
    const sealed = sealText('sealed summary', cipher);
    if (!sealed.ok) throw new Error('seal');
    expect(openStoredText(sealed.val, cipher)).toBe('sealed summary');
    expect(isSealed(sealed.val)).toBe(true);
    expect(isSealed(encryptContent('x', contentKey))).toBe(true);
    expect(isSealed('v1.a.b.c')).toBe(false);
    expect(parseEncryptionKey(contentKey.toString('base64')).ok).toBe(true);
  });
});
