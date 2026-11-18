/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Reading each host's runners with the organization's service accounts:
 * GitHub through the App's installation token, Bitbucket through its
 * workspace’s runners endpoint; what each refusal says;
 * and the minute's cache.
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';
import { forgetRunners, githubAppJwt, readBitbucketRunners, readGithubRunners } from './runners';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

let answers: Record<string, { status: number; body: unknown }>;
let calls: { url: string; method: string; authorization: string }[];

beforeEach(() => {
  forgetRunners();
  calls = [];
  answers = {};
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
    });
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    const answer = key ? answers[key] : { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
});

describe('the GitHub App’s JWT', () => {
  it('is signed with the App’s key, issued a minute back, for nine minutes', () => {
    const now = Date.UTC(2026, 10, 18, 10, 0, 0);
    const jwt = githubAppJwt('12345', pem, now);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: '12345',
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('GitHub runners', () => {
  const account = { org: 'acme-labs', appId: '12345', privateKey: pem };

  it('swaps the JWT for an installation token, and lists the organization’s runners with it', async () => {
    answers = {
      'https://api.github.com/orgs/acme-labs/installation': { status: 200, body: { id: 77 } },
      'https://api.github.com/app/installations/77/access_tokens': {
        status: 201,
        body: { token: 'ghs_install' },
      },
      'https://api.github.com/orgs/acme-labs/actions/runners': {
        status: 200,
        body: {
          runners: [
            { id: 1, name: 'workers-02', status: 'online', labels: [{ name: 'self-hosted' }] },
          ],
        },
      },
    };
    const read = await readGithubRunners(account);
    expect(read).toMatchObject({
      ok: true,
      runners: [{ host: 'github', name: 'workers-02', status: 'online' }],
    });
    expect(calls.map((c) => c.method + ' ' + c.url.replace('https://api.github.com', ''))).toEqual([
      'GET /orgs/acme-labs/installation',
      'POST /app/installations/77/access_tokens',
      'GET /orgs/acme-labs/actions/runners?per_page=100&page=1',
    ]);
    expect(calls[2].authorization).toBe('Bearer ghs_install');
    // Read once a minute.
    await readGithubRunners(account);
    expect(calls).toHaveLength(3);
    await readGithubRunners(account, { fresh: true });
    expect(calls).toHaveLength(6);
  });

  it('says the App is not installed, or lacks runner access', async () => {
    expect(await readGithubRunners(account)).toEqual({
      ok: false,
      error: 'The GitHub App is not installed on acme-labs; install it there first.',
    });
    answers = {
      'https://api.github.com/orgs/acme-labs/installation': { status: 200, body: { id: 77 } },
      'https://api.github.com/app/installations/77/access_tokens': {
        status: 201,
        body: { token: 't' },
      },
      'https://api.github.com/orgs/acme-labs/actions/runners': { status: 403, body: {} },
    };
    expect(await readGithubRunners(account, { fresh: true })).toEqual({
      ok: false,
      error:
        'GitHub would not let the service account read acme-labs’s runners; it needs read access to self-hosted runners.',
    });
  });

  it('says so when the private key cannot sign', async () => {
    expect(await readGithubRunners({ ...account, privateKey: 'not a key' })).toEqual({
      ok: false,
      error: 'The GitHub App’s private key could not be used; paste it again.',
    });
  });
});

describe('Bitbucket runners', () => {
  const account = {
    workspace: 'acme',
    auth: 'bearer' as const,
    email: '',
    token: 'workspace-token',
  };

  it('reads the workspace’s runners, following pages', async () => {
    const list = 'https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/runners';
    answers = {
      [`${list}?pagelen=100`]: {
        status: 200,
        body: {
          values: [
            {
              uuid: '{r1}',
              name: 'app-01',
              labels: ['self.hosted', 'onprem-app'],
              state: { status: 'ONLINE' },
            },
          ],
          next: `${list}?page=2&pagelen=100`,
        },
      },
      [`${list}?page=2&pagelen=100`]: {
        status: 200,
        body: {
          values: [{ uuid: '{r2}', name: 'app-02', labels: [], state: { status: 'OFFLINE' } }],
          next: 'https://elsewhere.test/steal',
        },
      },
    };
    const read = await readBitbucketRunners(account);
    expect(read.ok && read.runners.map((r) => [r.name, r.status])).toEqual([
      ['app-01', 'online'],
      ['app-02', 'offline'],
    ]);
    expect(calls[0].authorization).toBe('Bearer workspace-token');
  });

  it('signs in a bot account with its email and API token', async () => {
    await readBitbucketRunners({
      workspace: 'acme',
      auth: 'basic',
      email: 'ci-bot@acme.test',
      token: 'api-token',
    });
    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from('ci-bot@acme.test:api-token').toString('base64')}`
    );
  });

  it('says why the runners could not be read', async () => {
    answers = {};
    const read = await readBitbucketRunners(account);
    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.error).toContain('workspace acme’s runners');
    expect(calls).toHaveLength(1);
  });
});
