/**
 * The secrets module's own contract: a sealed secret opens only with its
 * passphrase (or the key derived from it) and refuses tampering; names,
 * fields, hosts and passphrases are validated the same way everywhere;
 * host scoping is exact-or-wildcard; and the scrub blanks every typed
 * value — including its URL-encoded form — from text bound for the model.
 */

import {
  deriveSecretKey,
  generatePassphrase,
  openSecretFields,
  openSecretFieldsWithKey,
  parseSecretRef,
  scrubSecretValues,
  sealSecretFields,
  sealedSalt,
  secretHostAllowed,
  secretTtlMs,
  unlockWindowMs,
  validatePassphrase,
  validateSecretFields,
  validateSecretHosts,
  validateSecretName,
  SECRET_MASK,
  SECRET_TTL_DEFAULT_MS,
  SECRET_TTL_MAX_MS,
  SECRET_UNLOCK_DEFAULT_MS,
  SECRET_UNLOCK_MAX_MS,
} from './secrets';

describe('sealing', () => {
  const fields = { username: 'alice', password: 'hunter2!' };

  it('round-trips with the passphrase and with the derived key, never with another', () => {
    const sealed = sealSecretFields(fields, 'correct horse battery');
    expect(sealed.startsWith('sbx1.')).toBe(true);
    expect(sealed).not.toContain('alice');
    expect(openSecretFields(sealed, 'correct horse battery')).toEqual(fields);
    expect(openSecretFields(sealed, 'wrong horse battery')).toBeNull();
    const key = deriveSecretKey('correct horse battery', sealedSalt(sealed)!);
    expect(openSecretFieldsWithKey(sealed, key)).toEqual(fields);
    expect(openSecretFieldsWithKey(sealed, Buffer.alloc(32))).toBeNull();
  });

  it('uses a fresh salt and iv every time, so two seals of one secret differ', () => {
    const a = sealSecretFields(fields, 'correct horse battery');
    const b = sealSecretFields(fields, 'correct horse battery');
    expect(a).not.toBe(b);
    expect(sealedSalt(a)!.equals(sealedSalt(b)!)).toBe(false);
  });

  it('refuses a tampered or malformed blob', () => {
    const sealed = sealSecretFields(fields, 'correct horse battery');
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[4], 'base64');
    flipped[0] ^= 0xff;
    parts[4] = flipped.toString('base64');
    expect(openSecretFields(parts.join('.'), 'correct horse battery')).toBeNull();
    expect(openSecretFields('v1.a.b.c', 'correct horse battery')).toBeNull();
    expect(openSecretFields('sbx1.a.b.c.d', 'correct horse battery')).toBeNull();
    expect(sealedSalt('nonsense')).toBeNull();
  });

  it('is a deterministic derivation of passphrase and salt', () => {
    const salt = Buffer.alloc(16, 7);
    expect(deriveSecretKey('pass phrase', salt).equals(deriveSecretKey('pass phrase', salt))).toBe(
      true
    );
    expect(deriveSecretKey('pass phrase', salt).equals(deriveSecretKey('pass phrasf', salt))).toBe(
      false
    );
    expect(deriveSecretKey('pass phrase', salt).byteLength).toBe(32);
  });
});

describe('generatePassphrase', () => {
  it('is five groups of five unambiguous characters, and different every time', () => {
    const one = generatePassphrase();
    expect(one).toMatch(/^[a-hj-km-np-z2-9]{5}(-[a-hj-km-np-z2-9]{5}){4}$/);
    expect(generatePassphrase()).not.toBe(one);
  });
});

describe('validation', () => {
  it('names are short lowercase slugs', () => {
    expect(validateSecretName(' Vendor-Portal ')).toEqual({ ok: true, name: 'vendor-portal' });
    expect(validateSecretName('-bad')).toMatchObject({ ok: false });
    expect(validateSecretName('a'.repeat(65))).toMatchObject({ ok: false });
    expect(validateSecretName(3)).toMatchObject({ ok: false });
  });

  it('fields are 1-8 named non-empty strings', () => {
    expect(validateSecretFields({ Username: 'a', password: 'b' })).toEqual({
      ok: true,
      fields: { username: 'a', password: 'b' },
    });
    expect(validateSecretFields({})).toMatchObject({ ok: false });
    expect(validateSecretFields({ 'bad name': 'x' })).toMatchObject({ ok: false });
    expect(validateSecretFields({ empty: '' })).toMatchObject({ ok: false });
    expect(validateSecretFields({ long: 'x'.repeat(4097) })).toMatchObject({ ok: false });
    expect(validateSecretFields({ n: 1 })).toMatchObject({ ok: false });
    expect(validateSecretFields(['a'])).toMatchObject({ ok: false });
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'v']));
    expect(validateSecretFields(nine)).toMatchObject({ ok: false });
  });

  it('hosts are hostnames or subdomain wildcards, read leniently from URLs and lists', () => {
    expect(validateSecretHosts('https://Portal.Vendor.com/login, *.vendor.com')).toEqual({
      ok: true,
      hosts: ['portal.vendor.com', '*.vendor.com'],
    });
    expect(validateSecretHosts(['portal.vendor.com', 'portal.vendor.com:8443'])).toEqual({
      ok: true,
      hosts: ['portal.vendor.com'],
    });
    expect(validateSecretHosts('')).toMatchObject({ ok: false });
    expect(validateSecretHosts('localhost')).toMatchObject({ ok: false });
    expect(validateSecretHosts('192.168.1.1')).toMatchObject({ ok: false });
    expect(validateSecretHosts('*')).toMatchObject({ ok: false });
    expect(validateSecretHosts('*.com')).toMatchObject({ ok: false });
    expect(
      validateSecretHosts(Array.from({ length: 9 }, (_, i) => `h${i}.example.com`))
    ).toMatchObject({
      ok: false,
    });
  });

  it('host scoping is exact, or the wildcard for subdomains only', () => {
    const hosts = ['portal.vendor.com', '*.corp.example'];
    expect(secretHostAllowed('portal.vendor.com', hosts)).toBe(true);
    expect(secretHostAllowed('PORTAL.vendor.com', hosts)).toBe(true);
    expect(secretHostAllowed('vendor.com', hosts)).toBe(false);
    expect(secretHostAllowed('evil-portal.vendor.com', hosts)).toBe(false);
    expect(secretHostAllowed('sso.corp.example', hosts)).toBe(true);
    expect(secretHostAllowed('a.b.corp.example', hosts)).toBe(true);
    expect(secretHostAllowed('corp.example', hosts)).toBe(false);
    expect(secretHostAllowed('corp.example.evil', hosts)).toBe(false);
    expect(secretHostAllowed('', hosts)).toBe(false);
  });

  it('passphrases are 12-256 characters', () => {
    expect(validatePassphrase('short')).toMatchObject({ ok: false });
    expect(validatePassphrase('x'.repeat(257))).toMatchObject({ ok: false });
    expect(validatePassphrase(undefined)).toMatchObject({ ok: false });
    expect(validatePassphrase('long enough passphrase')).toEqual({
      ok: true,
      passphrase: 'long enough passphrase',
    });
  });

  it('a secret ref is a name and a field', () => {
    expect(parseSecretRef({ name: 'Vendor-Portal', field: 'Password' })).toEqual({
      name: 'vendor-portal',
      field: 'password',
    });
    expect(parseSecretRef({ name: 'x' })).toBeNull();
    expect(parseSecretRef({ name: 'x', field: 'bad field' })).toBeNull();
    expect(parseSecretRef('vendor-portal.password')).toBeNull();
  });

  it('windows default and clamp', () => {
    expect(unlockWindowMs(undefined)).toBe(SECRET_UNLOCK_DEFAULT_MS);
    expect(unlockWindowMs(-1)).toBe(SECRET_UNLOCK_DEFAULT_MS);
    expect(unlockWindowMs(60_000)).toBe(60_000);
    expect(unlockWindowMs(10 ** 12)).toBe(SECRET_UNLOCK_MAX_MS);
    expect(secretTtlMs(undefined)).toBe(SECRET_TTL_DEFAULT_MS);
    expect(secretTtlMs(10 ** 15)).toBe(SECRET_TTL_MAX_MS);
  });
});

describe('scrubSecretValues', () => {
  it('blanks every value, its URL-encoded form too, and leaves tiny values alone', () => {
    const text = 'Welcome alice! q=hunter2%21 pw=hunter2! id=42';
    expect(scrubSecretValues(text, ['alice', 'hunter2!', '42'])).toBe(
      `Welcome ${SECRET_MASK}! q=${SECRET_MASK} pw=${SECRET_MASK} id=42`
    );
    expect(scrubSecretValues('nothing here', [])).toBe('nothing here');
  });
});
