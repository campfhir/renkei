/**
 * Sealing is @renkei/crypto's envelope behind a prefix of its own, and
 * the scrub is what keeps a value out of every answer — the two halves of
 * "the model sees names, never values".
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { openEnvValue, scrubEnv, sealEnvValue, type OpenedEnv } from './env-secrets';

const key = (() => {
  const parsed = parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  if (!parsed.ok) throw new Error('test key');
  return parsed.val;
})();

describe('env secrets', () => {
  it('round-trips a value under the env1 envelope', () => {
    const sealed = sealEnvValue('hunter22', key);
    expect(sealed.startsWith('env1.')).toBe(true);
    expect(openEnvValue(sealed, key)).toBe('hunter22');
  });

  it('refuses another envelope or another key', () => {
    const other = parseEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
    if (!other.ok) throw new Error('test key');
    expect(openEnvValue(sealEnvValue('x', key), other.val)).toBeNull();
    expect(openEnvValue('sbx1.not.an.env.value', key)).toBeNull();
  });

  it('masks every value, in every spelling, out of an answer', () => {
    const opened: OpenedEnv = {
      values: { NPM_TOKEN: 'tok-abc123', API_URL: 'https://x.example/?a=b c' },
      unreadable: [],
      usedIds: [],
    };
    const text =
      'token=tok-abc123 url=https%3A%2F%2Fx.example%2F%3Fa%3Db%20c plain=https://x.example/?a=b c';
    const scrubbed = scrubEnv(text, opened);
    expect(scrubbed).not.toContain('tok-abc123');
    expect(scrubbed).not.toContain('x.example');
    expect(scrubbed).toContain('••••••');
  });
});
