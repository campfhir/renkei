/**
 * The Jira Administration registration's save route, on the memory store:
 * what the admin form's Save stores (the ceiling as sent, on), that GET
 * reports a stored secret as present and never its value, and that a
 * blank secret keeps the stored one. These were jira-admin.spec.ts's
 * "saved for real" checks after the form's press; the form's rules are
 * app/(app)/admin/connectors/forms/app-registration-form.model.test.ts.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));

import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DEFAULT_ATLASSIAN_ADMIN_SCOPES } from '@/lib/atlassian-app';
import { GET, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/admin/connectors/atlassian-admin', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
const get = async () =>
  (await GET(new NextRequest('http://test.local/api/admin/connectors/atlassian-admin'))).json();

const NARROWED = 'read:jira-user read:jira-work manage:jira-configuration offline_access';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.RENKEI_CONFIG_CACHE_TTL_MS = '0';
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

describe('PUT /api/admin/connectors/atlassian-admin', () => {
  it('stores the narrowed ceiling, on, and GET reports the secret as stored, never its value', async () => {
    const saved = await put({
      clientId: 'e2e-admin-client',
      clientSecret: 'e2e-admin-secret',
      enabled: true,
      scopes: NARROWED,
    });
    expect(saved.status).toBe(200);

    const read = await get();
    expect(read).toMatchObject({
      configured: true,
      enabled: true,
      clientId: 'e2e-admin-client',
      scopes: NARROWED,
      redirectUri: null,
      hasClientSecret: true,
    });
    expect(JSON.stringify(read)).not.toContain('e2e-admin-secret');
  });

  it('a save with the secret left blank keeps the stored one', async () => {
    await put({ clientId: 'c', clientSecret: 's', scopes: NARROWED });
    const resaved = await put({ clientId: 'c2', enabled: false, scopes: NARROWED });
    expect(resaved.status).toBe(200);
    expect(await get()).toMatchObject({ clientId: 'c2', enabled: false, hasClientSecret: true });
  });

  it('refuses a first save with no secret', async () => {
    const response = await put({ clientId: 'c', scopes: NARROWED });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'clientSecret is required (none stored yet)' });
    expect((await get()).configured).toBe(false);
  });

  it('stores the whole default ceiling when none is sent, and a redirect override when one is', async () => {
    await put({ clientId: 'c', clientSecret: 's', redirectUri: 'https://renkei.example/cb' });
    expect(await get()).toMatchObject({
      scopes: DEFAULT_ATLASSIAN_ADMIN_SCOPES,
      redirectUri: 'https://renkei.example/cb',
    });
  });

  it('is an operator’s', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await put({ clientId: 'c', clientSecret: 's' })).status).toBe(401);
  });
});
