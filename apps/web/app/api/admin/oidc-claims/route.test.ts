/**
 * The sign-in claim mappings, on the memory store with no identity
 * provider set up: GET says nothing is configured (the state the audience
 * control reads as "no groups claim"), and a groups claim cannot be saved
 * until sign-in is. These were connector-audience-hint.spec.ts's requests.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/admin/oidc-claims', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

describe('/api/admin/oidc-claims with no identity provider', () => {
  it('reports nothing configured', async () => {
    const response = await GET(new NextRequest('http://test.local/api/admin/oidc-claims'));
    expect(response.status).toBe(200);
    expect((await response.json()).configured).toBe(false);
  });

  it('refuses a groups claim until sign-in is configured', async () => {
    const response = await put({ groupsClaim: 'e2e-member-of' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Sign-in is not configured yet' });
  });

  it('refuses a claim name it could not read from a token, before anything else', async () => {
    expect((await put({ groupsClaim: 'has spaces' })).status).toBe(400);
  });

  it('is an operator’s', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await GET(new NextRequest('http://test.local/api/admin/oidc-claims'))).status).toBe(
      401
    );
  });
});
