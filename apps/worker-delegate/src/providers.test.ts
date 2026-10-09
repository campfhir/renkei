/**
 * The host list and the stand-ins: a provider's token travels to its own
 * hosts over https and nowhere else, and the development stand-ins that
 * widen that are refused outright in production.
 */

import { GITHUB } from '@renkei/provider-grants';
import { hostAllowed, providerSpec, standInViolations, STAND_IN_ENV } from './providers';

function withEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(patch)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('hostAllowed', () => {
  const github = providerSpec(GITHUB);
  if (!github) throw new Error('github spec missing');

  it("allows the provider's own hosts over https and nothing else", () => {
    expect(hostAllowed(github, new URL('https://api.github.com/user'), GITHUB)).toBe(true);
    expect(hostAllowed(github, new URL('https://raw.githubusercontent.com/x'), GITHUB)).toBe(true);
    expect(hostAllowed(github, new URL('http://api.github.com/user'), GITHUB)).toBe(false);
    expect(hostAllowed(github, new URL('https://evil.example.com/'), GITHUB)).toBe(false);
    expect(hostAllowed(github, new URL('https://api.github.com.evil.example/'), GITHUB)).toBe(
      false
    );
  });

  it('honors a stand-in origin outside production, and ignores it in production', () => {
    const standIn = new URL('http://127.0.0.1:8092/github/api/user');
    withEnv({ NODE_ENV: 'test', GITHUB_API_BASE_URL: 'http://127.0.0.1:8092/github' }, () => {
      expect(hostAllowed(github, standIn, GITHUB)).toBe(true);
    });
    withEnv({ NODE_ENV: 'production', GITHUB_API_BASE_URL: 'http://127.0.0.1:8092/github' }, () => {
      expect(hostAllowed(github, standIn, GITHUB)).toBe(false);
    });
  });
});

describe('standInViolations', () => {
  it('names every stand-in set under NODE_ENV=production, so boot can refuse', () => {
    expect(
      standInViolations({
        NODE_ENV: 'production',
        GITHUB_API_BASE_URL: 'http://stub/github',
        JIRA_ADMIN_API_BASE_URL: 'http://stub/jira',
        BITBUCKET_API_BASE_URL: '   ',
      })
    ).toEqual(['GITHUB_API_BASE_URL', 'JIRA_ADMIN_API_BASE_URL']);
  });

  it('is silent outside production and when nothing is set', () => {
    expect(standInViolations({ NODE_ENV: 'development', GITHUB_API_BASE_URL: 'http://x' })).toEqual(
      []
    );
    expect(standInViolations({ NODE_ENV: 'production' })).toEqual([]);
    expect(Object.values(STAND_IN_ENV)).toHaveLength(4);
  });
});
