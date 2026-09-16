import { decryptCredentials, encryptCredentials, parseMirthCredentials } from './credentials';

const KEY = Buffer.alloc(32, 9);

describe('parseMirthCredentials', () => {
  it('accepts a username and password, trimming the name', () => {
    expect(parseMirthCredentials({ username: ' alice ', password: 's3cret' })).toEqual({
      username: 'alice',
      password: 's3cret',
    });
  });

  it('refuses partial or non-object input', () => {
    expect(parseMirthCredentials({ username: 'alice' })).toBeNull();
    expect(parseMirthCredentials({ password: 'x' })).toBeNull();
    expect(parseMirthCredentials({ username: '', password: 'x' })).toBeNull();
    expect(parseMirthCredentials('alice:x')).toBeNull();
    expect(parseMirthCredentials(null)).toBeNull();
  });
});

describe('credential envelope', () => {
  it('round-trips under the key', () => {
    const sealed = encryptCredentials({ username: 'alice', password: 'pw' }, KEY);
    expect(sealed).not.toContain('alice');
    expect(decryptCredentials(sealed, KEY)).toEqual({
      ok: true,
      val: { username: 'alice', password: 'pw' },
    });
  });

  it('fails closed on the wrong key and on malformed plaintext', () => {
    const sealed = encryptCredentials({ username: 'alice', password: 'pw' }, KEY);
    const wrong = decryptCredentials(sealed, Buffer.alloc(32, 1));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.err.type).toBe('DECRYPTION_ERROR');
  });
});
