import { createMemoryDataStore } from './memory';
import {
  SANDBOX_STORE_ALLOW_LIST,
  StoreCallRefused,
  createRemoteDataStore,
  decodeWire,
  dispatchStoreCall,
  encodeWire,
  type StoreCall,
} from './remote';

/** A sandbox's store wired straight to a store with rows: every call through the wire's JSON and the allow-list. */
function wired() {
  const real = createMemoryDataStore();
  const sent: StoreCall[] = [];
  const remote = createRemoteDataStore(async (call) => {
    sent.push(call);
    const overTheWire: unknown = JSON.parse(JSON.stringify(encodeWire(call.args)));
    const args = decodeWire(overTheWire);
    const answer = await dispatchStoreCall(real, SANDBOX_STORE_ALLOW_LIST, {
      ...call,
      args: Array.isArray(args) ? args : [],
    });
    return decodeWire(JSON.parse(JSON.stringify(encodeWire(answer))));
  });
  return { real, remote, sent };
}

describe('the wire', () => {
  it('carries dates, bytes and bigints through JSON and back as they were', () => {
    const value = {
      at: new Date('2026-01-02T03:04:05.678Z'),
      bytes: Buffer.from([0, 1, 255]),
      big: 9_007_199_254_740_993n,
      nested: [{ at: new Date(0), nothing: null }],
      text: 'plain',
      n: 7,
      yes: true,
    };
    const back = decodeWire(JSON.parse(JSON.stringify(encodeWire(value))));
    expect(back).toEqual(value);
  });

  it('drops undefined, as a statement would, and refuses what is not plain data', () => {
    expect(encodeWire({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(encodeWire(undefined)).toBeNull();
    expect(() => encodeWire({ at: new Map() })).toThrow(/plain data/);
  });

  it('leaves an ordinary object that merely has a $date among other fields alone', () => {
    expect(decodeWire({ $date: '2026-01-01T00:00:00.000Z', other: 1 })).toEqual({
      $date: '2026-01-01T00:00:00.000Z',
      other: 1,
    });
  });
});

describe('a sandbox’s store', () => {
  it('reads and writes its own tables through the process that has the database', async () => {
    const { real, remote } = wired();
    const expiresAt = new Date(Date.UTC(2026, 0, 2));
    const inserted = await remote.sandboxFiles.insert({
      id: '00000000-0000-4000-8000-000000000001',
      subject: 'ann',
      scope: '',
      filename: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'k',
      source: 'test',
      batchId: null,
      expiresAt,
    });
    expect(inserted.filename).toBe('notes.txt');
    // It is in the real store, and reads back through the remote one with its dates as dates.
    const listed = await remote.sandboxFiles.list('ann', '');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.expiresAt).toEqual(expiresAt);
    expect(await real.sandboxFiles.list('ann', '')).toHaveLength(1);
  });

  it('reads the organization’s settings but cannot change them', async () => {
    const { real, remote } = wired();
    await real.settings.set('log_level', 'debug');
    expect(await remote.settings.get('log_level')).toBe('debug');
    await expect(remote.settings.set('log_level', 'error')).rejects.toThrow(
      /settings.set is not a call a sandbox may make/
    );
    expect(await real.settings.get('log_level')).toBe('debug');
  });

  it.each([
    ['sessions', 'get'],
    ['identities', 'get'],
    ['chats', 'get'],
    ['connectorConfigs', 'get'],
    ['oauthTokens', 'find'],
    ['sandboxes', 'list'],
    ['sandboxArchives', 'get'],
  ])(
    'is refused %s.%s: nothing about people, chats, grants, keys or other sandboxes',
    async (domain, method) => {
      const { real } = wired();
      await expect(
        dispatchStoreCall(real, SANDBOX_STORE_ALLOW_LIST, { domain, method, args: ['x'] })
      ).rejects.toBeInstanceOf(StoreCallRefused);
    }
  );

  it('cannot reach anything that is not a repository’s own method by name', async () => {
    const { real } = wired();
    for (const [domain, method] of [
      ['sandboxFiles', 'constructor'],
      ['sandboxFiles', '__proto__'],
      ['sandboxFiles', 'toString'],
      ['__proto__', 'list'],
      ['constructor', 'name'],
      ['kind', 'length'],
    ]) {
      await expect(
        dispatchStoreCall(real, SANDBOX_STORE_ALLOW_LIST, {
          domain: domain!,
          method: method!,
          args: [],
        })
      ).rejects.toBeInstanceOf(StoreCallRefused);
    }
  });

  it('says it is remote, and is not mistaken for a promise or a memory store', async () => {
    const { remote } = wired();
    expect(remote.kind).toBe('remote');
    expect(await Promise.resolve(remote)).toBe(remote);
    expect('seed' in remote).toBe(false);
  });
});
