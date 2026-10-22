/**
 * Which org a salesforce_ call acts in: the one asked for when the person
 * is connected to it; with none asked, the only connection, or the one
 * production connection — never a guess between sandboxes — and a tool the
 * chosen connection's own capabilities do not cover is refused.
 */

import { EMPTY_POLICY, type SalesforceOrg } from '@renkei/connector-salesforce';
import type { SalesforceConnection } from '@/lib/salesforce-grants';
import { chooseConnection } from './org-choice';

const org = (key: string, sandbox: boolean, enabled = true): SalesforceOrg => ({
  key,
  name: key.toUpperCase(),
  myDomain: `https://acme-${key}.my.salesforce.com`,
  host: `acme-${key}.my.salesforce.com`,
  sandbox,
  enabled,
  clientId: `${key}-client`,
  scopes: ['sf-records-read', 'sf-records-write'],
  policy: EMPTY_POLICY,
  productionChanges: false,
});
const connection = (connector: string, scopes: string[]): SalesforceConnection => ({
  accountId: `00D/${connector}`,
  connector,
  displayName: 'Ada',
  username: 'ada@acme.org',
  instanceUrl: `https://acme-${connector}.my.salesforce.com`,
  requestedScopes: scopes,
});

const orgs = [org('prod', false), org('uat', true), org('dev', true), org('old', true, false)];

describe('chooseConnection', () => {
  it('uses the org asked for, by key or name, when connected', () => {
    const connections = [
      connection('prod', ['sf-records-read']),
      connection('uat', ['sf-records-read']),
    ];
    expect(chooseConnection(orgs, connections, 'uat', ['sf-records-read'])).toMatchObject({
      ok: true,
      org: { key: 'uat' },
    });
    expect(chooseConnection(orgs, connections, 'PROD', ['sf-records-read'])).toMatchObject({
      ok: true,
      org: { key: 'prod' },
    });
    expect(chooseConnection(orgs, connections, 'dev', [])).toMatchObject({
      ok: false,
      error: expect.stringContaining('not connected to Salesforce DEV'),
    });
    expect(chooseConnection(orgs, connections, 'staging', [])).toMatchObject({
      ok: false,
      error: expect.stringContaining('no Salesforce org "staging"'),
    });
    // A switched-off connector is not an org a call can act in.
    expect(
      chooseConnection(orgs, [connection('old', ['sf-records-read'])], 'old', [])
    ).toMatchObject({ ok: false });
  });

  it('defaults to the only connection, then to the one production connection', () => {
    expect(chooseConnection(orgs, [connection('uat', [])], undefined, [])).toMatchObject({
      ok: true,
      org: { key: 'uat' },
    });
    expect(
      chooseConnection(orgs, [connection('prod', []), connection('uat', [])], undefined, [])
    ).toMatchObject({ ok: true, org: { key: 'prod' } });
    // Two sandboxes and no production: say which.
    expect(
      chooseConnection(orgs, [connection('uat', []), connection('dev', [])], undefined, [])
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('say which with org'),
    });
    expect(chooseConnection(orgs, [], undefined, [])).toMatchObject({
      ok: false,
      error: expect.stringContaining('not connected'),
    });
  });

  it("refuses a tool the chosen connection's own capabilities do not cover", () => {
    const connections = [
      connection('prod', ['sf-records-read', 'sf-records-write']),
      connection('uat', ['sf-records-read']),
    ];
    expect(chooseConnection(orgs, connections, 'prod', ['sf-records-write'])).toMatchObject({
      ok: true,
    });
    expect(chooseConnection(orgs, connections, 'uat', ['sf-records-write'])).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'Your Salesforce UAT connection does not allow this (sf-records-write)'
      ),
    });
    expect(chooseConnection(orgs, connections, 'prod', ['__unmapped__'])).toMatchObject({
      ok: false,
    });
  });
});
