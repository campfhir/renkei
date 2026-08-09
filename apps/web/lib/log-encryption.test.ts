import { randomBytes } from 'node:crypto';
import { resolveLogCipher } from './log-encryption';

describe('resolveLogCipher', () => {
  const key = randomBytes(32).toString('base64');

  it('is off without a key', () => {
    expect(resolveLogCipher(undefined).state).toBe('off');
    expect(resolveLogCipher('').state).toBe('off');
  });

  it('rejects a malformed key', () => {
    expect(resolveLogCipher('not-a-key').state).toBe('invalid');
    expect(resolveLogCipher(randomBytes(16).toString('base64')).state).toBe('invalid');
  });

  it('round-trips through the adapter wire format', () => {
    const resolved = resolveLogCipher(key);
    if (resolved.state !== 'on') throw new Error('expected cipher on');
    const plaintext = '{"fields":{"summary":"secret payload"}}';
    // The adapter stores encrypt(...).toString('base64url') and hands that
    // exact string back to decrypt — mirror it.
    const stored = resolved.cipher.encrypt(plaintext).toString('base64url');
    expect(stored).not.toContain('secret payload');
    expect(resolved.cipher.decrypt(stored)).toBe(plaintext);
  });

  it('throws (not garbage) on a wrong key', () => {
    const a = resolveLogCipher(key);
    const b = resolveLogCipher(randomBytes(32).toString('base64'));
    if (a.state !== 'on' || b.state !== 'on') throw new Error('expected ciphers on');
    const stored = a.cipher.encrypt('payload').toString('base64url');
    expect(() => b.cipher.decrypt(stored)).toThrow(/decryption failed/);
  });
});
