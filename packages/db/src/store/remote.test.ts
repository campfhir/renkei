import { createMemoryDataStore } from './memory';
import {
  SANDBOX_STORE_POLICY,
  StoreCallRefused,
  createRemoteDataStore,
  decodeWire,
  dispatchStoreCall,
  encodeWire,
  type StoreCall,
  type StoreCaller,
} from './remote';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANN: StoreCaller = { kind: 'user', subjects: ['ann'] };
const PROJECT: StoreCaller = { kind: 'project', subjects: ['code-project:p1', 'ann', 'bob'] };
const SYSTEM: StoreCaller = { kind: 'system', subjects: [] };

/** A store with rows, and the store a sandbox sees of it: every call through the wire's JSON and the policy. */
function wired(caller: StoreCaller = ANN) {
  const real = createMemoryDataStore();
  const sent: StoreCall[] = [];
  const as = (who: StoreCaller) =>
    createRemoteDataStore(async (call) => {
      sent.push(call);
      const overTheWire: unknown = JSON.parse(JSON.stringify(encodeWire(call.args)));
      const args = decodeWire(overTheWire);
      const answer = await dispatchStoreCall(
        real,
        SANDBOX_STORE_POLICY,
        { ...call, args: Array.isArray(args) ? args : [] },
        who
      );
      return decodeWire(JSON.parse(JSON.stringify(encodeWire(answer))));
    });
  return { real, remote: as(caller), as, sent };
}

const file = (n: number, subject: string, expires = new Date(Date.UTC(2026, 0, 2))) => ({
  id: id(n),
  subject,
  scope: '',
  filename: `file-${n}.txt`,
  contentType: 'text/plain',
  sizeBytes: 12,
  storageKey: `k${n}`,
  source: 'test',
  batchId: null,
  expiresAt: expires,
});

const REFUSED = /scope this sandbox does not serve/;

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
  it('reads and writes the rows of the person it serves, through the process that has the database', async () => {
    const { real, remote } = wired();
    const inserted = await remote.sandboxFiles.insert(file(1, 'ann'));
    expect(inserted.filename).toBe('file-1.txt');
    const listed = await remote.sandboxFiles.list('ann', '');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.expiresAt).toEqual(new Date(Date.UTC(2026, 0, 2)));
    expect(await real.sandboxFiles.list('ann', '')).toHaveLength(1);
  });

  it('cannot read, write, count or delete another person’s rows, by subject', async () => {
    const { real, remote } = wired();
    await real.sandboxFiles.insert(file(2, 'bob'));
    await expect(remote.sandboxFiles.list('bob', '')).rejects.toThrow(REFUSED);
    await expect(remote.sandboxFiles.get('bob', '', id(2))).rejects.toThrow(REFUSED);
    await expect(remote.sandboxFiles.countForSubject('bob')).rejects.toThrow(REFUSED);
    await expect(remote.sandboxFiles.delete('bob', '', id(2))).rejects.toThrow(REFUSED);
    // Nor write a row in another's name.
    await expect(remote.sandboxFiles.insert(file(3, 'bob'))).rejects.toThrow(REFUSED);
    await expect(remote.sandboxEnvSecrets.listSealed('bob')).rejects.toThrow(REFUSED);
    await expect(remote.sandboxWorkspaces.list('bob')).rejects.toThrow(REFUSED);
    expect(await real.sandboxFiles.list('bob', '')).toHaveLength(1);
  });

  it('cannot act on another person’s row by its id either: whose it is is looked up first', async () => {
    const { real, remote } = wired();
    await real.sandboxFiles.insert(file(1, 'ann'));
    await real.sandboxFiles.insert(file(2, 'bob'));
    await expect(remote.sandboxFiles.deleteById(id(2))).rejects.toThrow(REFUSED);
    expect(await real.sandboxFiles.list('bob', '')).toHaveLength(1);
    // Its own goes; an id nobody holds is nobody's, and finds nothing.
    await remote.sandboxFiles.deleteById(id(1));
    await remote.sandboxFiles.deleteById(id(99));
    expect(await real.sandboxFiles.list('ann', '')).toHaveLength(0);
  });

  it('refuses a batch of ids when any one of them is another’s', async () => {
    const { real, remote } = wired();
    const secret = (n: number, subject: string) => ({
      id: id(n),
      subject,
      name: `S${n}`,
      sealed: 'env1.x',
      updatedAt: new Date(0),
    });
    await real.sandboxEnvSecrets.upsert(secret(1, 'ann'));
    await real.sandboxEnvSecrets.upsert(secret(2, 'bob'));
    await expect(remote.sandboxEnvSecrets.touchUsed([id(1), id(2)], new Date(1))).rejects.toThrow(
      REFUSED
    );
    await remote.sandboxEnvSecrets.touchUsed([id(1)], new Date(1));
  });

  it('sweeping what has expired sees only its own: another sandbox’s rows are not its to remove', async () => {
    const { real, remote } = wired();
    const past = new Date(Date.UTC(2025, 0, 1));
    await real.sandboxFiles.insert(file(1, 'ann', past));
    await real.sandboxFiles.insert(file(2, 'bob', past));
    const expired = await remote.sandboxFiles.listExpired(new Date(Date.UTC(2026, 0, 1)), 100);
    expect(expired.map((row) => row.subject)).toEqual(['ann']);
  });

  it('a project’s sandbox serves the project’s checkout and each member who has worked in it — and nobody else', async () => {
    const { real, as } = wired();
    const project = as(PROJECT);
    await project.sandboxFiles.insert(file(1, 'ann'));
    await project.sandboxFiles.insert(file(2, 'bob'));
    expect(await project.sandboxFiles.list('bob', '')).toHaveLength(1);
    await project.sandboxWorkspaces.list('code-project:p1');
    await expect(project.sandboxFiles.list('cy', '')).rejects.toThrow(REFUSED);
    await expect(project.sandboxWorkspaces.list('code-project:p2')).rejects.toThrow(REFUSED);
    expect(await real.sandboxFiles.list('ann', '')).toHaveLength(1);
  });

  it('reads the organization’s settings and image allow-list, and changes neither', async () => {
    const { real, remote } = wired();
    await real.settings.set('log_level', 'debug');
    expect(await remote.settings.get('log_level')).toBe('debug');
    await expect(remote.settings.set('log_level', 'error')).rejects.toThrow(
      /settings.set is not a call a sandbox may make/
    );
    expect(await remote.codeServiceImageRules.listForMatching()).toEqual([]);
    await expect(
      remote.codeServiceImageRules.insert({
        pattern: 'docker.io/evil/*',
        note: null,
        registryUsername: null,
        registrySealed: null,
      })
    ).rejects.toThrow(/the organization’s, not a sandbox’s, to change/);
    expect(await real.codeServiceImageRules.count()).toBe(0);
  });

  it('the system sandbox keeps the image allow-list for the organization, and serves no person', async () => {
    const { real, as } = wired();
    const system = as(SYSTEM);
    await system.codeServiceImageRules.insert({
      pattern: 'docker.io/library/postgres',
      note: null,
      registryUsername: null,
      registrySealed: null,
    });
    expect(await real.codeServiceImageRules.count()).toBe(1);
    await expect(system.sandboxFiles.list('ann', '')).rejects.toThrow(REFUSED);
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
        dispatchStoreCall(real, SANDBOX_STORE_POLICY, { domain, method, args: ['ann'] }, ANN)
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
        dispatchStoreCall(
          real,
          SANDBOX_STORE_POLICY,
          { domain: domain!, method: method!, args: [] },
          ANN
        )
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

describe('the sandbox policy', () => {
  const store = createMemoryDataStore();

  it('names only methods the store has', () => {
    for (const [domain, methods] of Object.entries(SANDBOX_STORE_POLICY)) {
      const repository: unknown = Reflect.get(store, domain);
      expect(typeof repository).toBe('object');
      for (const method of Object.keys(methods)) {
        expect([`${domain}.${method}`, typeof Reflect.get(Object(repository), method)]).toEqual([
          `${domain}.${method}`,
          'function',
        ]);
      }
    }
  });

  it('lists every method of the sandbox’s own repositories: a new one is unreachable until someone decides how it is scoped', () => {
    for (const domain of [
      'sandboxFiles',
      'sandboxWorkspaces',
      'sandboxServices',
      'sandboxSecrets',
      'sandboxEnvSecrets',
      'sandboxCrawls',
      'codeServiceImageRules',
    ]) {
      const repository: unknown = Reflect.get(store, domain);
      const has = Object.keys(Object(repository)).sort();
      expect([domain, Object.keys(SANDBOX_STORE_POLICY[domain] ?? {}).sort()]).toEqual([
        domain,
        has,
      ]);
    }
  });
});
