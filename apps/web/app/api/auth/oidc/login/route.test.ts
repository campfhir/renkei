/**
 * The sign-in start's throttle: every call inserts a pending state row and
 * fetches the IdP's discovery document with no session to gate on, so a
 * flood from one address is refused before the database is read.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/tenant-operations', () => ({ getTenantOidc: jest.fn() }));
jest.mock('@/lib/safe-fetch', () => ({ safeFetch: jest.fn() }));

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { GET } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

const TENANT = '00000000-0000-4000-8000-000000000001';

function loginRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/auth/oidc/login?tenantId=${TENANT}`, {
    headers: { 'x-forwarded-for': '203.0.113.3' },
  });
}

describe('GET /api/auth/oidc/login throttle', () => {
  beforeEach(() => {
    resetInboundLimits();
    mockGetDatabase.mockReset().mockReturnValue({ ok: false, err: 'DB_ERROR' });
  });

  it('refuses the 31st sign-in start from one address in a minute before the database', async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await GET(loginRequest());
      expect(response.status).not.toBe(429);
    }
    mockGetDatabase.mockClear();

    const throttled = await GET(loginRequest());
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});
