import { randomBytes } from 'node:crypto';
import { encrypt } from '@renkei/crypto';
import { decryptCredentials, encryptCredentials } from './credentials';
import type { ShareCredentials } from './credentials';

const key = randomBytes(32);

function roundtrip(credentials: ShareCredentials): void {
  const sealed = encryptCredentials(credentials, key);
  const opened = decryptCredentials(sealed, key);
  expect(opened.ok).toBe(true);
  if (opened.ok) expect(opened.val).toEqual(credentials);
}

describe('credential envelope', () => {
  it('round-trips each credential shape', () => {
    roundtrip({ protocol: 'smb', username: 'svc', password: 'pw', domain: 'CORP' });
    roundtrip({ protocol: 'smb', username: 'svc', password: 'pw' });
    roundtrip({ protocol: 'sftp', username: 'svc', password: 'pw' });
    roundtrip({ protocol: 'sftp', username: 'svc', privateKey: 'PEM', passphrase: 'pp' });
  });

  it('rejects ciphertext sealed under a different key', () => {
    const sealed = encryptCredentials({ protocol: 'sftp', username: 'svc', password: 'pw' }, key);
    const opened = decryptCredentials(sealed, randomBytes(32));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.err.type).toBe('DECRYPTION_ERROR');
  });

  it('rejects well-encrypted garbage', () => {
    const notJson = encrypt('not json', key);
    const opened = decryptCredentials(notJson, key);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.err.type).toBe('MALFORMED_CREDENTIALS');
  });

  it('rejects a document missing required fields', () => {
    const missingPassword = encrypt(JSON.stringify({ protocol: 'smb', username: 'svc' }), key);
    const opened = decryptCredentials(missingPassword, key);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.err.type).toBe('MALFORMED_CREDENTIALS');
  });

  it('rejects an unknown protocol', () => {
    const ftp = encrypt(JSON.stringify({ protocol: 'ftp', username: 'a', password: 'b' }), key);
    expect(decryptCredentials(ftp, key).ok).toBe(false);
  });
});
