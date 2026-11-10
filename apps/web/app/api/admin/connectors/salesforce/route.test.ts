/**
 * The Salesforce connectors' admin route (lib/salesforce-connectors-admin.ts),
 * run for real on the memory store, for both types: what the operator's
 * form saves and what the server refuses. These were salesforce.spec.ts's
 * and salesforce-admin.spec.ts's refusals and stored-config reads: a
 * generic login host is not a My Domain, two connectors cannot share an
 * org, a hidden field names its object, a blank secret keeps the stored
 * one, a domain is stored as the org's origin, and the ceiling is the
 * type's defaults unless chosen.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));

import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { getConnectorConfig } from '@renkei/connector-config';
import { loadKeyring } from '@renkei/crypto';
import { DELETE, GET, PUT } from './route';
import * as admin from '../salesforce-admin/route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

const URL_CRM = 'http://test.local/api/admin/connectors/salesforce';
const URL_ADMIN = 'http://test.local/api/admin/connectors/salesforce-admin';
const PRODUCTION = 'acme.my.salesforce.com';
const UAT = 'acme--uat.sandbox.my.salesforce.com';

const put = (body: unknown, url = URL_CRM) =>
  new NextRequest(url, { method: 'PUT', body: JSON.stringify(body) });
const getReq = (url = URL_CRM) => new NextRequest(url);
const del = (key: string, url = URL_CRM) =>
  new NextRequest(`${url}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });

interface Listed {
  enabled: boolean;
  connectors: {
    key: string;
    name: string;
    myDomain: string;
    sandbox: boolean;
    clientId: string;
    scopes: string;
    excludedObjects: string[];
    excludedFields: string[];
    hideRestricted: boolean;
    productionChanges: boolean;
    hasClientSecret: boolean;
  }[];
}

async function listed(get: typeof GET = GET, url = URL_CRM): Promise<Listed> {
  const response = await get(getReq(url));
  expect(response.status).toBe(200);
  return response.json();
}

const production = {
  name: 'Production',
  myDomain: `https://${PRODUCTION}/lightning/page/home`,
  sandbox: false,
  clientId: 'sf-client',
  clientSecret: 'sf-secret',
  enabled: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  mockCheckAccess.mockResolvedValue({ subject: 'ops@example.com' });
});

afterEach(() => resetDataStore());

it('refuses anyone but an operator', async () => {
  mockCheckAccess.mockResolvedValue(null);
  expect((await GET(getReq())).status).toBe(401);
  expect((await PUT(put(production))).status).toBe(401);
});

it('refuses the generic login host: a connector is the org’s own My Domain', async () => {
  const response = await PUT(put({ ...production, myDomain: 'login.salesforce.com' }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/My Domain must be the org’s own/);
  expect((await listed()).connectors).toEqual([]);
});

it('stores the org’s origin, keyed by its name, with the default ceiling, and switches the type on', async () => {
  const response = await PUT(put(production));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ connector: 'salesforce', key: 'production' });
  const { enabled, connectors } = await listed();
  expect(enabled).toBe(true);
  expect(connectors).toEqual([
    expect.objectContaining({
      key: 'production',
      name: 'Production',
      myDomain: `https://${PRODUCTION}`,
      sandbox: false,
      clientId: 'sf-client',
      hideRestricted: false,
      hasClientSecret: true,
    }),
  ]);
  expect(connectors[0]?.scopes.split(' ').sort()).toEqual([
    'sf-records-read',
    'sf-records-write',
    'sf-reports',
  ]);
});

it('never lists a stored secret, only that there is one', async () => {
  await PUT(put(production));
  const text = JSON.stringify(await listed());
  expect(text).not.toContain('sf-secret');
});

it('refuses a second connector on the same org', async () => {
  await PUT(put(production));
  const response = await PUT(
    put({ ...production, name: 'UAT', myDomain: PRODUCTION, clientId: 'uat-client' })
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe(`${PRODUCTION} is already the Production connector.`);
  expect((await listed()).connectors.map((org) => org.key)).toEqual(['production']);
});

it('refuses a capability the type does not have', async () => {
  const response = await PUT(put({ ...production, scopes: 'sf-records-read sfa-schema' }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe('Unknown capabilities: sfa-schema');
});

it('needs a consumer secret until one is stored, then keeps it when left blank', async () => {
  const { clientSecret: _secret, ...withoutSecret } = production;
  const refused = await PUT(put(withoutSecret));
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toMatch(/consumer secret is required/);

  await PUT(put(production));
  const saved = await PUT(
    put({ ...withoutSecret, key: 'production', clientId: 'sf-client-2', clientSecret: '  ' })
  );
  expect(saved.status).toBe(200);
  const { connectors } = await listed();
  expect(connectors[0]).toMatchObject({ clientId: 'sf-client-2', hasClientSecret: true });
  const key = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!key.ok) throw new Error('no key');
  const config = await getConnectorConfig('salesforce', key.val);
  expect(config.ok && config.val?.secrets['clientSecret:production']).toBe('sf-secret');
});

it('saves a sandbox beside production, and what each keeps from the assistant', async () => {
  await PUT(put(production));
  await PUT(
    put({
      name: 'UAT',
      myDomain: UAT,
      sandbox: true,
      clientId: 'uat-client',
      clientSecret: 'uat-secret',
    })
  );
  // A field without its object is refused, naming the shape.
  const bad = await PUT(
    put({
      key: 'uat',
      name: 'UAT',
      myDomain: UAT,
      sandbox: true,
      clientId: 'uat-client',
      excludedFields: 'Diagnosis__c',
    })
  );
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toMatch(/Hidden fields are Object\.Field API names/);

  const good = await PUT(
    put({
      key: 'uat',
      name: 'UAT',
      myDomain: UAT,
      sandbox: true,
      clientId: 'uat-client',
      scopes: 'sf-records-read sf-records-write sf-reports',
      excludedObjects: 'Case_Note__c',
      excludedFields: 'Contact.Diagnosis__c',
      hideRestricted: true,
    })
  );
  expect(good.status).toBe(200);
  const { connectors } = await listed();
  expect(connectors.map((org) => [org.key, org.myDomain, org.sandbox, org.clientId])).toEqual([
    ['production', `https://${PRODUCTION}`, false, 'sf-client'],
    ['uat', `https://${UAT}`, true, 'uat-client'],
  ]);
  expect([
    connectors[1]?.excludedObjects,
    connectors[1]?.excludedFields,
    connectors[1]?.hideRestricted,
  ]).toEqual([['Case_Note__c'], ['Contact.Diagnosis__c'], true]);
  expect(connectors[0]?.hideRestricted).toBe(false);
});

it('removes a connector by key, and the type switches off with the last one', async () => {
  await PUT(put(production));
  expect((await DELETE(del('full-copy'))).status).toBe(404);
  const removed = await DELETE(del('production'));
  expect(removed.status).toBe(200);
  expect(await listed()).toMatchObject({ enabled: false, connectors: [] });
});

describe('the admin type', () => {
  const uat = {
    name: 'UAT',
    myDomain: UAT,
    sandbox: true,
    clientId: 'admin-uat-client',
    clientSecret: 'admin-uat-secret',
    productionChanges: false,
  };

  it('keeps its own list, with user access off unless chosen', async () => {
    const response = await admin.PUT(put(uat, URL_ADMIN));
    expect(response.status).toBe(200);
    const { connectors } = await listed(admin.GET, URL_ADMIN);
    expect(connectors[0]?.scopes.split(' ').sort()).toEqual([
      'sfa-layouts',
      'sfa-permissions',
      'sfa-read',
      'sfa-schema',
    ]);
    expect((await listed()).connectors).toEqual([]);
  });

  it('stores production read only unless change requests are allowed', async () => {
    await admin.PUT(put(uat, URL_ADMIN));
    await admin.PUT(
      put(
        { ...uat, name: 'Production', myDomain: PRODUCTION, sandbox: false, clientId: 'p' },
        URL_ADMIN
      )
    );
    const { connectors } = await listed(admin.GET, URL_ADMIN);
    expect(connectors.map((org) => [org.key, org.sandbox, org.productionChanges])).toEqual([
      ['uat', true, false],
      ['production', false, false],
    ]);
    await admin.PUT(
      put(
        {
          key: 'production',
          name: 'Production',
          myDomain: PRODUCTION,
          sandbox: false,
          clientId: 'p',
          productionChanges: true,
        },
        URL_ADMIN
      )
    );
    expect((await listed(admin.GET, URL_ADMIN)).connectors[1]?.productionChanges).toBe(true);
  });
});
