/**
 * The Targets page's data: targets with the runners that fit them on each
 * host, runners in no target, what each host could be read for; saving a
 * target, its problems named; and the service accounts' secrets kept
 * write-only.
 */

jest.mock('./runners', () => ({ readBitbucketRunners: jest.fn(), readGithubRunners: jest.fn() }));

import { randomBytes } from 'node:crypto';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateConnectorConfigCache } from '@renkei/connector-config';
import { readBitbucketRunners, readGithubRunners } from './runners';
import { accountsView, saveBitbucketAccount, saveGithubAccount } from './accounts';
import {
  createTarget,
  parseTargetPayload,
  targetsPage,
  updateTarget,
  type TargetPayload,
} from './targets';

const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
});
beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateConnectorConfigCache();
  jest.mocked(readBitbucketRunners).mockResolvedValue({
    ok: true,
    readAt: '2026-11-18T10:00:00.000Z',
    runners: [
      {
        host: 'bitbucket',
        id: '{1}',
        name: 'app-01',
        labels: ['self.hosted', 'linux', 'onprem-app'],
        status: 'online',
        busy: false,
      },
      {
        host: 'bitbucket',
        id: '{2}',
        name: 'dmz-01',
        labels: ['self.hosted', 'linux', 'dmz'],
        status: 'offline',
        busy: false,
      },
    ],
  });
  jest.mocked(readGithubRunners).mockResolvedValue({
    ok: false,
    error: 'The GitHub App is not installed on acme; install it there first.',
  });
});
afterEach(() => resetDataStore());

const payload = (body: unknown): TargetPayload => {
  const parsed = parseTargetPayload(body);
  if ('error' in parsed) throw new Error(parsed.problems.join());
  return parsed;
};

describe('the service accounts', () => {
  it('are kept with their secrets write-only, and a blank secret keeps the stored one', async () => {
    expect(
      await saveBitbucketAccount({ workspace: 'acme', auth: 'bearer', token: 'secret-token' })
    ).toEqual({ ok: true, value: true });
    expect(await saveGithubAccount({ org: 'acme', appId: '42', privateKey: KEY })).toEqual({
      ok: true,
      value: true,
    });
    expect(await saveGithubAccount({ org: 'acme-labs', appId: '42', privateKey: '' })).toEqual({
      ok: true,
      value: true,
    });
    expect(await accountsView()).toEqual({
      ok: true,
      value: {
        bitbucket: { workspace: 'acme', auth: 'bearer', email: '', hasToken: true },
        github: { org: 'acme-labs', appId: '42', hasKey: true },
      },
    });
  });

  it('names what is missing', async () => {
    expect(
      await saveBitbucketAccount({ workspace: 'acme', auth: 'basic', email: 'nope', token: 't' })
    ).toEqual({
      ok: false,
      error: 'A bot account signs in with its email.',
    });
    expect(
      await saveGithubAccount({ org: 'acme', appId: '42', privateKey: 'pasted half a key' })
    ).toEqual({
      ok: false,
      error: 'Paste the whole private key file, from -----BEGIN to -----END.',
    });
  });
});

describe('the Targets page', () => {
  it('shows each target with the runners that fit, the runners in no target, and what each host said', async () => {
    await saveBitbucketAccount({ workspace: 'acme', auth: 'bearer', token: 't' });
    await saveGithubAccount({ org: 'acme', appId: '42', privateKey: KEY });
    await createTarget(
      payload({ name: 'onprem-app', labels: { bitbucket: 'self.hosted linux onprem-app' } }),
      'ada'
    );
    const page = await targetsPage();
    if ('error' in page) throw new Error(page.error);
    expect(page.targets).toMatchObject([{ name: 'onprem-app', total: 1, online: 1 }]);
    expect(page.targets[0].runners.bitbucket.map((r) => r.name)).toEqual(['app-01']);
    expect(page.loose.map((r) => r.name)).toEqual(['dmz-01']);
    expect(page.hosts).toEqual({
      bitbucket: { connected: true, readAt: '2026-11-18T10:00:00.000Z', error: null, count: 2 },
      github: {
        connected: true,
        readAt: null,
        error: 'The GitHub App is not installed on acme; install it there first.',
        count: 0,
      },
    });
  });

  it('reads no host without an account', async () => {
    const page = await targetsPage();
    if ('error' in page) throw new Error(page.error);
    expect(page.hosts.bitbucket).toEqual({ connected: false, readAt: null, error: null, count: 0 });
    expect(readBitbucketRunners).not.toHaveBeenCalled();
  });
});

describe('saving a target', () => {
  it('names its problems, and refuses a taken name', async () => {
    expect(parseTargetPayload({ name: 'Onprem', labels: { github: 'linux onprem' } })).toEqual({
      error: 'The target cannot be saved yet.',
      problems: [
        'Name the target in lower case: letters, digits and -, like onprem-app.',
        'GitHub labels must include self-hosted, or the job goes to a hosted runner.',
      ],
    });
    const first = await createTarget(
      payload({ name: 'onprem-app', labels: { github: ['self-hosted', 'app'] } }),
      'ada'
    );
    expect(
      await createTarget(
        payload({ name: 'onprem-app', labels: { github: ['self-hosted', 'x'] } }),
        'ada'
      )
    ).toEqual({
      ok: false,
      error: 'taken',
    });
    if (!first.ok) throw new Error('not created');
    expect(
      await updateTarget(
        first.id,
        payload({ name: 'onprem-web', labels: { github: 'self-hosted web' } })
      )
    ).toEqual({ ok: true });
  });
});
