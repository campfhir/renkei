/**
 * The host list and the stand-ins: a provider's token travels to its own
 * hosts over https and nowhere else, and the development stand-ins that
 * widen that are refused outright in production.
 */

import type { ConnectorConfig } from '@renkei/connector-config';
import { GITHUB, SALESFORCE, SALESFORCE_ADMIN, type ProviderGrant } from '@renkei/provider-grants';
import {
  hostAllowed,
  providerSpec,
  standInViolations,
  tokenEndpointFor,
  STAND_IN_ENV,
  type ProviderSpec,
} from './providers';

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

describe('Salesforce: one host per org, from the app registration', () => {
  const spec = providerSpec(SALESFORCE);
  if (!spec?.hostsFor) throw new Error('salesforce spec missing');
  const config: ConnectorConfig = {
    connector: SALESFORCE,
    enabled: true,
    settings: {
      orgs: [
        {
          key: 'production',
          name: 'Production',
          myDomain: 'acme.my.salesforce.com',
          clientId: 'prod-key',
        },
        {
          key: 'uat',
          name: 'UAT',
          myDomain: 'acme--uat.sandbox.my.salesforce.com',
          sandbox: true,
          clientId: 'uat-key',
        },
        {
          key: 'old',
          name: 'Old',
          myDomain: 'acme--old.sandbox.my.salesforce.com',
          clientId: 'old-key',
          enabled: false,
        },
      ],
    },
    secrets: { 'clientSecret:production': 'prod-secret', 'clientSecret:uat': 'uat-secret' },
  };
  const grantIn = (instanceUrl: string): ProviderGrant => ({
    provider: SALESFORCE,
    accountId: '00D/005',
    clientId: 'prod-key',
    displayName: 'Ada',
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date().toISOString(),
    requestedScopes: [],
    grantedScopes: null,
    metadata: { instanceUrl },
    subject: 'ada',
  });

  it("allows a grant's own org host alone, never another org's", () => {
    const uatHosts =
      spec.hostsFor?.(config, grantIn('https://acme--uat.sandbox.my.salesforce.com'), null) ?? [];
    expect(uatHosts).toEqual(['acme--uat.sandbox.my.salesforce.com']);
    const allowed = (url: string): boolean => hostAllowed(spec, new URL(url), SALESFORCE, uatHosts);
    expect(
      allowed('https://acme--uat.sandbox.my.salesforce.com/services/data/v68.0/sobjects')
    ).toBe(true);
    // Production is registered too, but this token is the sandbox's.
    expect(allowed('https://acme.my.salesforce.com/services/data/v68.0/sobjects')).toBe(false);
    expect(allowed('https://other.my.salesforce.com/')).toBe(false);
    expect(allowed('http://acme--uat.sandbox.my.salesforce.com/')).toBe(false);
    expect(allowed('https://acme--uat.sandbox.my.salesforce.com:8443/')).toBe(false);
  });

  it('allows nothing for a grant or pending token from an org that is not registered', () => {
    expect(spec.hostsFor?.(config, grantIn('https://removed.my.salesforce.com'), null)).toEqual([]);
    expect(spec.hostsFor?.(config, null, 'https://stranger.my.salesforce.com')).toEqual([]);
    expect(spec.hostsFor?.(config, null, 'https://acme.my.salesforce.com')).toEqual([
      'acme.my.salesforce.com',
    ]);
    expect(spec.hostsFor?.(null, null, null)).toEqual([]);
  });

  it("trades codes at the chosen org's endpoint with that org's own app", () => {
    expect(tokenEndpointFor(spec, config, 'uat')).toBe(
      'https://acme--uat.sandbox.my.salesforce.com/services/oauth2/token'
    );
    expect(tokenEndpointFor(spec, config, 'production')).toBe(
      'https://acme.my.salesforce.com/services/oauth2/token'
    );
    // No connector named, or one switched off: no endpoint.
    expect(tokenEndpointFor(spec, config)).toBeNull();
    expect(tokenEndpointFor(spec, config, 'old')).toBeNull();
    expect(spec.credentialsFor?.(config, 'uat')).toEqual({
      clientId: 'uat-key',
      clientSecret: 'uat-secret',
    });
    expect(spec.credentialsFor?.(config, 'production')).toEqual({
      clientId: 'prod-key',
      clientSecret: 'prod-secret',
    });
  });

  it('refreshes at the endpoint of the org the grant belongs to', () => {
    expect(
      spec.adapter(config, grantIn('https://acme--uat.sandbox.my.salesforce.com'))
    ).not.toBeNull();
    expect(spec.adapter(config, grantIn('https://removed.my.salesforce.com'))).toBeNull();
    // A switched-off connector neither refreshes nor carries its grants' tokens.
    expect(spec.adapter(config, grantIn('https://acme--old.sandbox.my.salesforce.com'))).toBeNull();
    expect(
      spec.hostsFor?.(config, grantIn('https://acme--old.sandbox.my.salesforce.com'), null)
    ).toEqual([]);
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
    // Jira Administration and JSM share one, the Jira gateway's.
    expect(Object.values(STAND_IN_ENV)).toHaveLength(6);
    expect(new Set(Object.values(STAND_IN_ENV)).size).toBe(5);
  });
});

describe('a dynamic (MCP server) provider', () => {
  const spec: ProviderSpec = {
    connector: 'mcp:x',
    tokenEndpoint: 'https://auth.example/token',
    hosts: [],
    origins: ['https://mcp.example', 'http://127.0.0.1:9000'],
    clientAuth: 'none',
    adapter: () => null,
  };

  it("sends the token only to the server's own origin", () => {
    expect(hostAllowed(spec, new URL('https://mcp.example/mcp'))).toBe(true);
    expect(hostAllowed(spec, new URL('http://127.0.0.1:9000/mcp'))).toBe(true);
    expect(hostAllowed(spec, new URL('https://mcp.example.evil.test/mcp'))).toBe(false);
    expect(hostAllowed(spec, new URL('https://auth.example/token'))).toBe(false);
    expect(hostAllowed(spec, new URL('http://mcp.example/mcp'))).toBe(false);
  });
});

describe('Salesforce admin: a separate provider with the same per-org rules', () => {
  it('reads its own config row and pins each grant to its org', () => {
    const spec = providerSpec(SALESFORCE_ADMIN);
    expect(spec?.connector).toBe(SALESFORCE_ADMIN);
    const config: ConnectorConfig = {
      connector: SALESFORCE_ADMIN,
      enabled: true,
      settings: {
        orgs: [
          {
            key: 'uat',
            name: 'UAT',
            myDomain: 'acme--uat.sandbox.my.salesforce.com',
            sandbox: true,
            clientId: 'admin-uat-key',
          },
        ],
      },
      secrets: { 'clientSecret:uat': 'admin-uat-secret' },
    };
    expect(spec?.credentialsFor?.(config, 'uat')).toEqual({
      clientId: 'admin-uat-key',
      clientSecret: 'admin-uat-secret',
    });
    expect(spec?.hostsFor?.(config, null, 'https://acme--uat.sandbox.my.salesforce.com')).toEqual([
      'acme--uat.sandbox.my.salesforce.com',
    ]);
    expect(spec?.hostsFor?.(config, null, 'https://acme.my.salesforce.com')).toEqual([]);
  });
});
