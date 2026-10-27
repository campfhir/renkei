/**
 * The sign-in start's throttle: every call inserts a pending state row and
 * fetches the IdP's discovery document with no session to gate on, so a
 * flood from one address is refused before the store is written.
 */

jest.mock('@/lib/tenant-operations', () => ({ getTenantOidc: jest.fn() }));
jest.mock('@/lib/safe-fetch', () => ({ safeFetch: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { GET } from './route';

const { getTenantOidc: mockGetTenantOidc } = jest.requireMock<{ getTenantOidc: jest.Mock }>(
  '@/lib/tenant-operations'
);

function loginRequest(): NextRequest {
  return new NextRequest('http://localhost/api/auth/oidc/login', {
    headers: { 'x-forwarded-for': '203.0.113.3' },
  });
}

describe('GET /api/auth/oidc/login throttle', () => {
  let created: string[];

  beforeEach(() => {
    resetInboundLimits();
    created = [];
    const store = createMemoryDataStore();
    registerDataStore({
      ...store,
      pendingSignins: {
        ...store.pendingSignins,
        create: (pending) => {
          created.push(pending.state);
          return store.pendingSignins.create(pending);
        },
      },
    });
    mockGetTenantOidc.mockReset().mockResolvedValue({
      ok: true,
      val: { issuer: 'https://idp.example', clientId: 'renkei', clientSecret: 's' },
    });
  });

  afterEach(() => resetDataStore());

  it('refuses the 31st sign-in start from one address in a minute before the store', async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await GET(loginRequest());
      expect(response.status).not.toBe(429);
    }
    expect(created).toHaveLength(30);
    created.length = 0;

    const throttled = await GET(loginRequest());
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(created).toHaveLength(0);
  });
});
