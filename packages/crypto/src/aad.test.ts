/**
 * Associated data on the secretbox (audit R-04): a v3 envelope opens only for
 * the purpose (and row) it was sealed for; legacy v1/v2 envelopes keep opening
 * where no AAD is demanded; a credential copied into a knowledge chunk, with
 * the content marker prepended, is not revealed.
 */

import { randomBytes } from 'node:crypto';
import {
  AAD_PURPOSE,
  aadFor,
  decrypt,
  decryptBound,
  encrypt,
  envelopeKeyId,
  isBoundEnvelope,
  keyId,
  parseKeyring,
} from './secretbox';
import { CONTENT_ENVELOPE_PREFIX, decryptContent, encryptContent, revealContent } from './content';

const bare = randomBytes(32);
const ringResult = parseKeyring(randomBytes(32).toString('base64'));
if (!ringResult.ok) throw new Error('keyring');
const ring = ringResult.val;

describe('secretbox associated data', () => {
  it('round-trips under the same aad, as v3 naming the key', () => {
    for (const key of [bare, ring]) {
      const sealed = encrypt('s3cret', key, 'connector-config');
      expect(sealed).toMatch(/^v3\./);
      expect(envelopeKeyId(sealed)).toBe(keyId(key));
      expect(isBoundEnvelope(sealed)).toBe(true);
      const opened = decrypt(sealed, key, 'connector-config');
      expect(opened.ok && opened.val).toBe('s3cret');
    }
  });

  it('fails under a different aad, and a different row of the same purpose', () => {
    const sealed = encrypt('s3cret', ring, aadFor('connector-config', 'github'));
    expect(decrypt(sealed, ring, aadFor('connector-config', 'jira')).ok).toBe(false);
    expect(decrypt(sealed, ring, 'connector-config').ok).toBe(false);
    expect(decrypt(sealed, ring, aadFor('llm-model-key', 'github')).ok).toBe(false);
  });

  it('a v3 envelope never opens without its aad', () => {
    const sealed = encrypt('s3cret', ring, 'x');
    expect(decrypt(sealed, ring).ok).toBe(false);
  });

  it('legacy v1 and v2 still open when no aad is demanded', () => {
    const v1 = encrypt('old', bare);
    const v2 = encrypt('old', ring);
    expect(v1).toMatch(/^v1\./);
    expect(v2).toMatch(/^v2\./);
    expect(decrypt(v1, bare)).toMatchObject({ ok: true, val: 'old' });
    expect(decrypt(v2, ring)).toMatchObject({ ok: true, val: 'old' });
  });

  it('a strict decrypt refuses a legacy envelope; decryptBound accepts it and says so', () => {
    const v2 = encrypt('old', ring);
    expect(decrypt(v2, ring, 'p').ok).toBe(false);
    const bound = decryptBound(v2, ring, 'p', {});
    expect(bound.ok && bound.val).toEqual({ value: 'old', legacy: true });
    const fresh = decryptBound(encrypt('new', ring, 'p'), ring, 'p', {});
    expect(fresh.ok && fresh.val).toEqual({ value: 'new', legacy: false });
  });

  it('decryptBound refuses legacy envelopes under RENKEI_REQUIRE_AAD and a v3 of another purpose always', () => {
    const v2 = encrypt('old', ring);
    expect(decryptBound(v2, ring, 'p', { RENKEI_REQUIRE_AAD: '1' }).ok).toBe(false);
    expect(decryptBound(encrypt('x', ring, 'q'), ring, 'p', {}).ok).toBe(false);
  });

  it('a rotated ring opens a v3 sealed under a previous key', () => {
    const old = parseKeyring(randomBytes(32).toString('base64'));
    if (!old.ok) throw new Error('keyring');
    const sealed = encrypt('x', old.val, 'p');
    const rotated = parseKeyring(
      `${randomBytes(32).toString('base64')},${old.val.toString('base64')}`
    );
    if (!rotated.ok) throw new Error('keyring');
    expect(decrypt(sealed, rotated.val, 'p')).toMatchObject({ ok: true, val: 'x' });
  });
});

describe('relocation between purposes', () => {
  it('seal as purpose A, open as purpose B: fails', () => {
    const sealed = encrypt(
      '{"clientSecret":"abc"}',
      ring,
      aadFor(AAD_PURPOSE.connectorConfig, 'github')
    );
    expect(decrypt(sealed, ring, aadFor(AAD_PURPOSE.llmModelKey)).ok).toBe(false);
    expect(decrypt(sealed, ring, aadFor(AAD_PURPOSE.oidcClientSecret)).ok).toBe(false);
    expect(decrypt(sealed, ring, aadFor(AAD_PURPOSE.knowledgeChunk)).ok).toBe(false);
  });

  it('knowledge reveal refuses a connector-config envelope moved into a chunk', () => {
    const connectorBlob = encrypt(
      '{"clientSecret":"abc","webhookSecret":"def"}',
      ring,
      aadFor(AAD_PURPOSE.connectorConfig, 'github')
    );
    const relocated = CONTENT_ENVELOPE_PREFIX + connectorBlob;
    const shown = revealContent(relocated, ring);
    expect(shown).toBe('[content unavailable: decryption failed]');
    expect(shown).not.toContain('abc');
    expect(decryptContent(relocated, ring).ok).toBe(false);
  });

  it('new content envelopes are bound; another purpose does not reveal them', () => {
    const stored = encryptContent('body', ring);
    expect(stored.startsWith(`${CONTENT_ENVELOPE_PREFIX}v3.`)).toBe(true);
    expect(revealContent(stored, ring)).toBe('body');
    expect(revealContent(stored, ring, 'something-else')).toBe(
      '[content unavailable: decryption failed]'
    );
  });

  it('legacy chunks (no aad) still reveal', () => {
    const legacy = CONTENT_ENVELOPE_PREFIX + encrypt('old body', ring);
    expect(revealContent(legacy, ring)).toBe('old body');
  });
});
