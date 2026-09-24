import { decryptCredentials, encryptCredentials, parseAdManagerCredentials } from './credentials';

const KEY = Buffer.alloc(32, 9);

describe('parseAdManagerCredentials', () => {
  it('accepts an authtoken, trimming it', () => {
    expect(parseAdManagerCredentials({ authToken: ' abc123 ' })).toEqual({
      authToken: 'abc123',
    });
  });

  it('refuses empty or non-object input', () => {
    expect(parseAdManagerCredentials({ authToken: '' })).toBeNull();
    expect(parseAdManagerCredentials({ authToken: '   ' })).toBeNull();
    expect(parseAdManagerCredentials({})).toBeNull();
    expect(parseAdManagerCredentials('abc123')).toBeNull();
    expect(parseAdManagerCredentials(null)).toBeNull();
  });
});

describe('credential envelope', () => {
  it('round-trips under the key', () => {
    const sealed = encryptCredentials({ authToken: 'abc123' }, KEY);
    expect(sealed).not.toContain('abc123');
    expect(decryptCredentials(sealed, KEY)).toEqual({
      ok: true,
      val: { authToken: 'abc123' },
    });
  });

  it('fails closed on the wrong key and on malformed plaintext', () => {
    const sealed = encryptCredentials({ authToken: 'abc123' }, KEY);
    const wrong = decryptCredentials(sealed, Buffer.alloc(32, 1));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.err.type).toBe('DECRYPTION_ERROR');
  });
});
