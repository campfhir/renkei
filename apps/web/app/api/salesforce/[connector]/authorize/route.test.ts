/**
 * Connecting one Salesforce connector (lib/salesforce-connect-authorize.ts),
 * run for real on the memory store with connectors saved through the
 * operator's own admin route: the redirect is a PKCE consent request to
 * that org's own My Domain with its own consumer key and Salesforce's
 * fixed scopes, the person's narrowing is recorded on the pending sign-in
 * and never sent, a capability beyond the ceiling is refused (400) and a
 * connector that is not set up is unavailable (503). These were the
 * authorize checks in salesforce.spec.ts and salesforce-admin.spec.ts,
 * which keep one real connect each.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(async () => ({ subject: 'ops@example.com' })),
  ROLE_OPERATOR: 'renkei-operator',
}));

import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { PUT as savePUT } from '../../../admin/connectors/salesforce/route';
import { PUT as saveAdminPUT } from '../../../admin/connectors/salesforce-admin/route';
import { GET as adminAuthorize } from '../../../salesforce-admin/[connector]/authorize/route';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const ME = 'ada@example.com';
const UAT = 'acme--uat.sandbox.my.salesforce.com';
const ORIGIN = 'https://renkei.example';

const params = (connector: string) => ({ params: Promise.resolve({ connector }) });
const authorize = (connector: string, query = '') =>
  GET(
    new NextRequest(`${ORIGIN}/api/salesforce/${connector}/authorize${query}`),
    params(connector)
  );

async function save(put: typeof savePUT, url: string, body: Record<string, unknown>) {
  const response = await put(new NextRequest(url, { method: 'PUT', body: JSON.stringify(body) }));
  expect(response.status).toBe(200);
}

const uat = {
  name: 'UAT',
  myDomain: UAT,
  sandbox: true,
  clientId: 'uat-client',
  clientSecret: 'uat-secret',
  scopes: 'sf-records-read sf-records-write sf-reports',
};

beforeEach(async () => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.RENKEI_CONFIG_CACHE_TTL_MS = '0';
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  await save(savePUT, `${ORIGIN}/api/admin/connectors/salesforce`, uat);
});

afterEach(() => resetDataStore());
afterAll(() => {
  delete process.env.RENKEI_CONFIG_CACHE_TTL_MS;
});

it('sends the person to the sandbox’s own My Domain with its own key, PKCE and the fixed scopes', async () => {
  const response = await authorize('uat');
  expect([302, 307]).toContain(response.status);
  const consent = new URL(response.headers.get('location') ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('uat-client');
  expect(consent.searchParams.get('scope')).toBe('api refresh_token id');
  expect(consent.searchParams.get('response_type')).toBe('code');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const state = consent.searchParams.get('state') ?? '';
  expect(state).toBeTruthy();

  const pending = await getDataStore().pendingSignins.findByState(state);
  expect(pending).toMatchObject({ subject: ME, provider: 'salesforce', connectorKey: 'uat' });
  expect(pending?.scopes?.split(' ').sort()).toEqual([
    'sf-records-read',
    'sf-records-write',
    'sf-reports',
  ]);
});

it('records the person’s narrowing on the sign-in, never in the consent request', async () => {
  const response = await authorize('uat', '?scopes=sf-records-read+sf-reports');
  const consent = new URL(response.headers.get('location') ?? '');
  expect(consent.searchParams.get('scope')).toBe('api refresh_token id');
  const pending = await getDataStore().pendingSignins.findByState(
    consent.searchParams.get('state') ?? ''
  );
  expect(pending?.scopes).toBe('sf-records-read sf-reports');
});

it('refuses a capability beyond the connector’s ceiling instead of dropping it', async () => {
  const response = await authorize('uat', '?scopes=sf-records-read+sf-records-delete');
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe('Capabilities not allowed for UAT: sf-records-delete');
});

it('says a connector that is not set up is unavailable', async () => {
  const response = await authorize('full-copy');
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatch(/not set up, or is switched off/);
});

it('asks the person to sign in first', async () => {
  mockGetSession.mockResolvedValue(null);
  expect((await authorize('uat')).status).toBe(401);
});

it('an admin connector connects at its own org with its own app, apart from the CRM’s', async () => {
  await save(saveAdminPUT, `${ORIGIN}/api/admin/connectors/salesforce-admin`, {
    ...uat,
    clientId: 'admin-uat-client',
    scopes: undefined,
  });
  const response = await adminAuthorize(
    new NextRequest(`${ORIGIN}/api/salesforce-admin/uat/authorize`),
    params('uat')
  );
  expect([302, 307]).toContain(response.status);
  const consent = new URL(response.headers.get('location') ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('admin-uat-client');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  const pending = await getDataStore().pendingSignins.findByState(
    consent.searchParams.get('state') ?? ''
  );
  expect(pending?.provider).toBe('salesforce-admin');
});
