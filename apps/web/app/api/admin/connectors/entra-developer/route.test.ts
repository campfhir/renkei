/**
 * The Entra Developer registration's save route, on the memory store:
 * what the admin form's Save stores (the directory, the ceiling as sent,
 * on), that GET reports a stored secret as present and never its value,
 * and the fields it refuses without. These were entra-developer.spec.ts's
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
import { GET, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

const DIRECTORY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NARROWED =
  'Application.Read.All Application.ReadWrite.All AppRoleAssignment.ReadWrite.All User.ReadBasic.All openid profile email offline_access User.Read';

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/admin/connectors/entra-developer', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
const get = async () =>
  (await GET(new NextRequest('http://test.local/api/admin/connectors/entra-developer'))).json();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.RENKEI_CONFIG_CACHE_TTL_MS = '0';
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

describe('PUT /api/admin/connectors/entra-developer', () => {
  it('stores the directory and the narrowed ceiling, on; GET never shows the secret', async () => {
    const saved = await put({
      clientId: 'e2e-entra-client',
      directoryTenantId: DIRECTORY_ID,
      clientSecret: 'e2e-entra-secret',
      enabled: true,
      scopes: NARROWED,
    });
    expect(saved.status).toBe(200);

    const read = await get();
    expect(read).toMatchObject({
      configured: true,
      enabled: true,
      clientId: 'e2e-entra-client',
      directoryTenantId: DIRECTORY_ID,
      scopes: NARROWED,
      hasClientSecret: true,
    });
    expect(JSON.stringify(read)).not.toContain('e2e-entra-secret');
  });

  it('refuses a save with no directory', async () => {
    const response = await put({ clientId: 'c', clientSecret: 's', directoryTenantId: '' });
    expect(response.status).toBe(400);
    expect((await get()).configured).toBe(false);
  });

  it('a blank secret keeps the stored one; none stored refuses', async () => {
    expect(
      (await put({ clientId: 'c', directoryTenantId: DIRECTORY_ID, scopes: NARROWED })).status
    ).toBe(400);
    await put({ clientId: 'c', directoryTenantId: DIRECTORY_ID, clientSecret: 's' });
    const resaved = await put({ clientId: 'c', directoryTenantId: DIRECTORY_ID, enabled: false });
    expect(resaved.status).toBe(200);
    expect(await get()).toMatchObject({ enabled: false, hasClientSecret: true });
  });
});
