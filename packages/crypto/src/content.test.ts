/**
 * The content-at-rest envelope: round-trip, legacy passthrough, and the
 * failure markers surfaces render instead of ciphertext or a 500.
 */

import { randomBytes } from 'node:crypto';
import {
  contentEncryptionKey,
  encryptContent,
  decryptContent,
  isEncryptedContent,
  revealContent,
  CONTENT_ENVELOPE_PREFIX,
} from './content';

const key = randomBytes(32);

describe('content envelope', () => {
  it('round-trips and is recognizable', () => {
    const stored = encryptContent('The escalation policy is…', key);
    expect(stored.startsWith(CONTENT_ENVELOPE_PREFIX)).toBe(true);
    expect(isEncryptedContent(stored)).toBe(true);
    expect(stored).not.toContain('escalation');

    const opened = decryptContent(stored, key);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.val).toBe('The escalation policy is…');
  });

  it('passes legacy plaintext through untouched', () => {
    expect(isEncryptedContent('plain old chunk text')).toBe(false);
    const opened = decryptContent('plain old chunk text', key);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.val).toBe('plain old chunk text');
    expect(revealContent('plain old chunk text', null)).toBe('plain old chunk text');
  });

  it('reveals a marker, not ciphertext, on the failure modes', () => {
    const stored = encryptContent('secret', key);
    expect(revealContent(stored, null)).toContain('content unavailable');
    expect(revealContent(stored, randomBytes(32))).toContain('content unavailable');
    expect(revealContent(stored, key)).toBe('secret');
  });

  it('resolves the key from CONTENT_ENCRYPTION_KEY with TOKEN fallback', () => {
    const savedContent = process.env.CONTENT_ENCRYPTION_KEY;
    const savedToken = process.env.TOKEN_ENCRYPTION_KEY;
    try {
      delete process.env.CONTENT_ENCRYPTION_KEY;
      delete process.env.TOKEN_ENCRYPTION_KEY;
      expect(contentEncryptionKey().ok).toBe(false);

      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      expect(contentEncryptionKey().ok).toBe(true);

      process.env.CONTENT_ENCRYPTION_KEY = 'not-a-key';
      expect(contentEncryptionKey().ok).toBe(false);

      process.env.CONTENT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      expect(contentEncryptionKey().ok).toBe(true);
    } finally {
      if (savedContent === undefined) delete process.env.CONTENT_ENCRYPTION_KEY;
      else process.env.CONTENT_ENCRYPTION_KEY = savedContent;
      if (savedToken === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedToken;
    }
  });
});
