import { generateKeyPairSync } from 'node:crypto';
import {
  hostKeyFingerprint,
  hostKeyMismatchMessage,
  makeHostVerifier,
  normalizeHostKeyFingerprint,
  type HostKeyVerdict,
} from './host-key';

/** An ed25519 host key as ssh2 hands it to hostVerifier: the raw SSH wire blob. */
function sshKeyBlob(): Buffer {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const type = Buffer.from('ssh-ed25519');
  const length = (bytes: Buffer): Buffer => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    return header;
  };
  return Buffer.concat([length(type), type, length(raw), raw]);
}

describe('hostKeyFingerprint', () => {
  it('is OpenSSH’s SHA256 form: prefix plus unpadded base64 of the key blob', () => {
    const fingerprint = hostKeyFingerprint(sshKeyBlob());
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprint.endsWith('=')).toBe(false);
  });

  it('is deterministic for a key and different for another', () => {
    const key = sshKeyBlob();
    expect(hostKeyFingerprint(key)).toBe(hostKeyFingerprint(key));
    expect(hostKeyFingerprint(key)).not.toBe(hostKeyFingerprint(sshKeyBlob()));
  });
});

describe('normalizeHostKeyFingerprint', () => {
  const canonical = hostKeyFingerprint(sshKeyBlob());
  const body = canonical.slice('SHA256:'.length);

  it('accepts what ssh-keygen prints, with or without the prefix or padding', () => {
    expect(normalizeHostKeyFingerprint(canonical)).toBe(canonical);
    expect(normalizeHostKeyFingerprint(` ${canonical} `)).toBe(canonical);
    expect(normalizeHostKeyFingerprint(`sha256:${body}`)).toBe(canonical);
    expect(normalizeHostKeyFingerprint(body)).toBe(canonical);
    expect(normalizeHostKeyFingerprint(`${canonical}=`)).toBe(canonical);
  });

  it('is null for nothing and undefined for something that is not a SHA-256 fingerprint', () => {
    expect(normalizeHostKeyFingerprint('')).toBeNull();
    expect(normalizeHostKeyFingerprint('   ')).toBeNull();
    expect(normalizeHostKeyFingerprint('MD5:aa:bb:cc')).toBeUndefined();
    expect(normalizeHostKeyFingerprint('SHA256:tooshort')).toBeUndefined();
    expect(normalizeHostKeyFingerprint(`SHA256:${body}!`)).toBeUndefined();
  });
});

describe('makeHostVerifier (ssh2’s synchronous hostVerifier contract)', () => {
  const key = sshKeyBlob();
  const other = sshKeyBlob();

  it('accepts the pinned key and reports the match', () => {
    const verdicts: HostKeyVerdict[] = [];
    const verify = makeHostVerifier(hostKeyFingerprint(key), (verdict) => verdicts.push(verdict));
    expect(verify(key)).toBe(true);
    expect(verdicts).toEqual([
      { seen: hostKeyFingerprint(key), pinned: hostKeyFingerprint(key), accepted: true },
    ]);
  });

  it('refuses any other key and names both fingerprints', () => {
    let verdict: HostKeyVerdict | null = null;
    const verify = makeHostVerifier(hostKeyFingerprint(key), (seen) => (verdict = seen));
    expect(verify(other)).toBe(false);
    expect(verdict).toEqual({
      seen: hostKeyFingerprint(other),
      pinned: hostKeyFingerprint(key),
      accepted: false,
    });
    const message = hostKeyMismatchMessage('files.corp.example', verdict!);
    expect(message).toContain(hostKeyFingerprint(other));
    expect(message).toContain(hostKeyFingerprint(key));
    expect(message).toMatch(/Refusing to connect/);
  });

  it('accepts a first connection with nothing pinned and reports what it saw, for recording', () => {
    let verdict: HostKeyVerdict | null = null;
    const verify = makeHostVerifier(null, (seen) => (verdict = seen));
    expect(verify(key)).toBe(true);
    expect(verdict).toEqual({ seen: hostKeyFingerprint(key), pinned: null, accepted: true });
  });
});
