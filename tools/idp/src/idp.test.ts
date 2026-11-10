/**
 * The identity provider CLI's behaviour, on the memory store: a record
 * created the way the app creates it, changed the way the terminal asks.
 */

import { randomBytes } from 'node:crypto';
import {
  AAD_PURPOSE,
  aadFor,
  decryptBoundValue,
  encrypt,
  isBoundEnvelope,
  parseKeyring,
} from '@renkei/crypto';
import { createMemoryDataStore, type DataStore } from '@renkei/db';
import { UsageError, applyChange, parseArgs, showIdp, summaryLines } from './idp';

function ring() {
  const parsed = parseKeyring(randomBytes(32).toString('base64'));
  if (!parsed.ok) throw new Error('test key did not parse');
  return parsed.val;
}
const keyring = ring();

async function configured(): Promise<DataStore> {
  const store = createMemoryDataStore();
  await store.oidcConfig.save({
    id: '00000000-0000-4000-8000-0000000001dc',
    issuer: 'https://idp.example.com',
    clientId: 'renkei',
    clientSecret: encrypt('expired-secret', keyring, aadFor(AAD_PURPOSE.oidcClientSecret)),
    roleClaim: 'roles',
    operatorIdpValue: 'renkei-operator',
    userIdpValue: 'renkei-user',
    groupsClaim: 'groups',
  });
  return store;
}

async function storedSecret(store: DataStore): Promise<string | null> {
  const record = await store.oidcConfig.get();
  if (!record) return null;
  // Written as the web app reads it: bound to its purpose, never the legacy form.
  if (!isBoundEnvelope(record.clientSecret)) return null;
  const opened = decryptBoundValue(
    record.clientSecret,
    keyring,
    aadFor(AAD_PURPOSE.oidcClientSecret)
  );
  return opened.ok ? opened.val : null;
}

describe('the command line', () => {
  it('reads show, help and nothing at all', () => {
    expect(parseArgs(['show'])).toEqual({ kind: 'show' });
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('asks for the client secret apart from the command line', () => {
    expect(parseArgs(['set', '--client-secret'])).toEqual({
      kind: 'set',
      change: {},
      readSecret: true,
    });
  });

  it('refuses a client secret written on the command line', () => {
    expect(() => parseArgs(['set', '--client-secret=hunter2'])).toThrow(UsageError);
  });

  it('takes values after a space or an equals sign, and an empty one clears a claim', () => {
    expect(
      parseArgs([
        'set',
        '--client-id',
        'new-id',
        '--issuer=https://idp.example.org',
        '--groups-claim',
        '',
      ])
    ).toEqual({
      kind: 'set',
      change: { clientId: 'new-id', issuer: 'https://idp.example.org', groupsClaim: null },
      readSecret: false,
    });
  });

  it('refuses an empty client id, a non-https issuer, an unknown option and a set that names nothing', () => {
    expect(() => parseArgs(['set', '--client-id', ''])).toThrow(UsageError);
    expect(() => parseArgs(['set', '--issuer', 'http://idp.example.com'])).toThrow(UsageError);
    expect(() => parseArgs(['set', '--issuer', 'idp'])).toThrow(UsageError);
    expect(() => parseArgs(['set', '--discovery', 'x'])).toThrow(UsageError);
    expect(() => parseArgs(['set', '--client-id'])).toThrow(UsageError);
    expect(() => parseArgs(['set'])).toThrow(UsageError);
    expect(() => parseArgs(['drop'])).toThrow(UsageError);
  });
});

describe('show', () => {
  it('prints the record without its secret', async () => {
    const store = await configured();
    const summary = await showIdp(store, keyring);
    expect(summary).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'renkei',
      clientSecret: 'stored',
      roleClaim: 'roles',
      operatorIdpValue: 'renkei-operator',
      userIdpValue: 'renkei-user',
      groupsClaim: 'groups',
    });
    expect(summaryLines(summary!).join('\n')).not.toContain('expired-secret');
  });

  it('says when this key does not open the stored secret', async () => {
    const store = await configured();
    const summary = await showIdp(store, ring());
    expect(summary?.clientSecret).toMatch(/does not open it/);
  });

  it('is null before first-run setup', async () => {
    expect(await showIdp(createMemoryDataStore(), keyring)).toBeNull();
  });
});

describe('set', () => {
  it('replaces the client secret, sealed, and nothing else', async () => {
    const store = await configured();
    const before = await store.oidcConfig.get();

    const result = await applyChange(store, keyring, { clientSecret: 'fresh-secret' });

    expect(result).toMatchObject({ ok: true, changed: ['clientSecret'] });
    const after = await store.oidcConfig.get();
    expect(after?.clientSecret).not.toContain('fresh-secret');
    expect(await storedSecret(store)).toBe('fresh-secret');
    expect({ ...after, clientSecret: null }).toEqual({ ...before, clientSecret: null });
  });

  it('replaces the client id and issuer and keeps the stored secret', async () => {
    const store = await configured();

    await applyChange(store, keyring, { clientId: 'renkei-2', issuer: 'https://idp.example.org' });

    expect(await store.oidcConfig.get()).toMatchObject({
      issuer: 'https://idp.example.org',
      clientId: 'renkei-2',
      roleClaim: 'roles',
      operatorIdpValue: 'renkei-operator',
      groupsClaim: 'groups',
    });
    expect(await storedSecret(store)).toBe('expired-secret');
  });

  it('changes and clears claim fields, leaving the ones not named', async () => {
    const store = await configured();

    const result = await applyChange(store, keyring, {
      operatorIdpValue: 'admins',
      groupsClaim: null,
    });

    expect(result).toMatchObject({ ok: true, changed: ['operatorIdpValue', 'groupsClaim'] });
    expect(await store.oidcConfig.get()).toMatchObject({
      roleClaim: 'roles',
      operatorIdpValue: 'admins',
      userIdpValue: 'renkei-user',
      groupsClaim: null,
    });
    expect(await storedSecret(store)).toBe('expired-secret');
  });

  it('changes the secret and a claim in one go', async () => {
    const store = await configured();

    await applyChange(store, keyring, { clientSecret: 'fresh-secret', roleClaim: null });

    expect(await storedSecret(store)).toBe('fresh-secret');
    expect((await store.oidcConfig.get())?.roleClaim).toBeNull();
  });

  it('refuses an empty secret and changes nothing', async () => {
    const store = await configured();
    expect(await applyChange(store, keyring, { clientSecret: '' })).toEqual({
      ok: false,
      reason: 'empty-secret',
    });
    expect(await storedSecret(store)).toBe('expired-secret');
  });

  it('creates nothing where no provider is configured', async () => {
    const store = createMemoryDataStore();
    expect(await applyChange(store, keyring, { clientSecret: 'fresh-secret' })).toEqual({
      ok: false,
      reason: 'not-configured',
    });
    expect(await store.oidcConfig.get()).toBeNull();
  });
});
