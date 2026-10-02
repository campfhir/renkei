/**
 * The ciphers over the envelopes, strictly: a chat's cipher seals `renc2`
 * under its key and opens only rows under that key — a row under another
 * key, under the retired deployment key, or in plaintext is a marker,
 * never bytes and never a throw; a person's cipher does the same over
 * `uenc1`; an unavailable cipher refuses to seal and names why it cannot
 * open.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { encryptContent, sealForUser } from '@renkei/crypto';
import {
  openBlocks,
  openText,
  resourceCipher,
  sealBlocks,
  sealText,
  unavailableCipher,
  userCipher,
} from './content-crypto';

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
    expect(cipher.unavailable).toBeNull();
  });

  it('does not open the retired deployment-key envelope, or plaintext', () => {
    expect(openText(encryptContent('older', randomBytes(32)), cipher)).toContain('retired');
    expect(openText('plain text', cipher)).toContain('content unavailable');
    expect(openText('plain text', cipher)).not.toContain('plain text');
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
    // A marker reads back as one text block, so a thread still renders.
    expect(openBlocks('plain', cipher)).toEqual([
      { type: 'text', text: expect.stringContaining('content unavailable') },
    ]);
  });
});

describe('userCipher', () => {
  it('seals uenc1 under the person’s key and opens nothing else', () => {
    const kek = randomBytes(32);
    const cipher = userCipher(kek);
    const sealed = sealText('a note', cipher);
    expect(sealed.ok && sealed.val.startsWith('uenc1:')).toBe(true);
    if (!sealed.ok) return;
    expect(openText(sealed.val, cipher)).toBe('a note');
    expect(openText(sealed.val, userCipher(randomBytes(32)))).toBe(
      '[content unavailable: decryption failed]'
    );
    expect(openText(sealForUser('x', randomBytes(32)), cipher)).toContain('decryption failed');
    const underChatKey = sealText('x', resourceCipher(chatKey));
    expect(underChatKey.ok && openText(underChatKey.val, cipher)).toContain('retired');
    expect(cipher.keyId).toBeNull();
  });
});

describe('unavailableCipher', () => {
  it('refuses to seal and says why it cannot open', () => {
    const locked = unavailableCipher('locked');
    expect(locked.unavailable).toBe('locked');
    const sealed = sealText('x', locked);
    expect(!sealed.ok && sealed.err.type).toBe('CONTENT_KEY');
    expect(openText('anything', locked)).toContain('locked');
    expect(openText('anything', locked)).toContain('Preferences');
    const missing = unavailableCipher('no-key');
    expect(openText('anything', missing)).toContain('no key');
    expect(openBlocks('anything', missing)).toEqual([
      { type: 'text', text: expect.stringContaining('no key') },
    ]);
  });
});
