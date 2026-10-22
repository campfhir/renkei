import {
  findOrg,
  orgForInstance,
  orgKeyOf,
  takesChanges,
  orgsFromSettings,
  validateOrg,
  type SalesforceOrg,
} from './orgs';

const saved = {
  orgs: [
    {
      key: 'production',
      name: 'Production',
      myDomain: 'acme.my.salesforce.com',
      clientId: 'prod-key',
      scopes: 'sf-records-read sf-reports',
    },
    {
      key: 'uat',
      name: 'UAT',
      myDomain: 'acme--uat.sandbox.my.salesforce.com',
      sandbox: true,
      enabled: false,
      clientId: 'uat-key',
      scopes: ['sf-records-read'],
    },
    { key: 'bad', name: 'Bad', myDomain: 'login.salesforce.com', clientId: 'x' },
    { key: 'nokey', name: 'No key', myDomain: 'nokey.my.salesforce.com' },
    { key: 'dupe', name: 'Dupe', myDomain: 'acme.my.salesforce.com', clientId: 'y' },
  ],
};

describe('Salesforce connectors (one per org)', () => {
  it('reads each saved connector and skips bad or duplicate ones', () => {
    const orgs = orgsFromSettings(saved);
    expect(orgs.map((org) => org.key)).toEqual(['production', 'uat']);
    expect(orgs[0]).toMatchObject({
      enabled: true,
      sandbox: false,
      clientId: 'prod-key',
      scopes: ['sf-records-read', 'sf-reports'],
    });
    expect(orgs[1]).toMatchObject({
      enabled: false,
      sandbox: true,
      clientId: 'uat-key',
      scopes: ['sf-records-read'],
    });
    expect(orgsFromSettings({})).toEqual([]);
    expect(orgsFromSettings({ myDomain: 'acme.my.salesforce.com' })).toEqual([]);
  });

  it('finds a connector by instance, key or name', () => {
    const orgs = orgsFromSettings(saved);
    expect(orgForInstance(orgs, 'https://acme--uat.sandbox.my.salesforce.com')?.key).toBe('uat');
    expect(orgForInstance(orgs, 'https://other.my.salesforce.com')).toBeNull();
    expect(findOrg(orgs, 'UAT')?.key).toBe('uat');
    expect(findOrg(orgs, 'staging')).toBeNull();
  });

  it('validates one connector against the others', () => {
    const orgs: SalesforceOrg[] = orgsFromSettings(saved);
    expect(
      validateOrg(
        {
          name: 'Full Copy',
          myDomain: 'https://acme--full.sandbox.my.salesforce.com/',
          clientId: ' full-key ',
          sandbox: true,
        },
        orgs
      )
    ).toMatchObject({
      ok: true,
      org: {
        key: 'full-copy',
        myDomain: 'https://acme--full.sandbox.my.salesforce.com',
        clientId: 'full-key',
        sandbox: true,
        enabled: true,
      },
    });
    expect(
      validateOrg({ name: 'X', myDomain: 'test.salesforce.com', clientId: 'k' }, orgs)
    ).toMatchObject({ ok: false });
    expect(validateOrg({ name: 'X', myDomain: 'x.my.salesforce.com' }, orgs)).toEqual({
      ok: false,
      error: 'The consumer key is required.',
    });
    expect(
      validateOrg({ name: 'Other', myDomain: 'ACME.my.salesforce.com', clientId: 'k' }, orgs)
    ).toEqual({
      ok: false,
      error: 'acme.my.salesforce.com is already the Production connector.',
    });
    expect(
      validateOrg({ name: 'uat', myDomain: 'z.my.salesforce.com', clientId: 'k' }, orgs)
    ).toMatchObject({ ok: false });
    // Editing keeps the key, and may keep its own domain and name.
    expect(
      validateOrg(
        { name: 'Live', myDomain: 'acme.my.salesforce.com', clientId: 'k2' },
        orgs,
        'production'
      )
    ).toMatchObject({
      ok: true,
      org: { key: 'production', name: 'Live' },
    });
    expect(orgKeyOf('  Full Copy #2 ')).toBe('full-copy-2');
    expect(orgKeyOf('--UAT--')).toBe('uat');
    expect(orgKeyOf('!!!')).toBe('org');
    expect(orgKeyOf(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
    // A long run of dashes is where /^-+|-+$/ backtracked.
    const started = Date.now();
    orgKeyOf(`${'-'.repeat(50_000)}x`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('takesChanges', () => {
  it('lets any sandbox take change requests, and production only when allowed', () => {
    const settings = {
      orgs: [
        {
          key: 'production',
          name: 'Production',
          myDomain: 'acme.my.salesforce.com',
          clientId: 'p',
        },
        {
          key: 'uat',
          name: 'UAT',
          myDomain: 'acme--uat.sandbox.my.salesforce.com',
          sandbox: true,
          clientId: 'u',
        },
        {
          key: 'prod-2',
          name: 'Prod 2',
          myDomain: 'acme2.my.salesforce.com',
          clientId: 'p2',
          productionChanges: true,
        },
      ],
    };
    expect(orgsFromSettings(settings).map((org) => [org.key, takesChanges(org)])).toEqual([
      ['production', false],
      ['uat', true],
      ['prod-2', true],
    ]);
  });
});
