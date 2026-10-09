/**
 * The token endpoint's throttle: unauthenticated until a client secret
 * verifies, so a flood from one address must be refused before the org's
 * settings or the database are read.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function tokenRequest(ip: string): NextRequest {
  return new NextRequest(`http://localhost/api/mcp/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': ip,
    },
    body: 'grant_type=refresh_token&refresh_token=guess',
  });
}

describe('POST /api/mcp/{tenantId}/oauth/token throttle', () => {
  beforeEach(() => {
    resetInboundLimits();
    mockGetOrgSettings.mockReset().mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    mockGetDatabase.mockReset().mockReturnValue({ ok: false, err: 'DB_ERROR' });
  });

  it('refuses the 61st request from one address in a minute before reading anything', async () => {
    for (let i = 0; i < 60; i += 1) {
      const response = await POST(tokenRequest('203.0.113.1'), {
        params: Promise.resolve({ tenantId: TENANT }),
      });
      expect(response.status).not.toBe(429);
    }
    mockGetOrgSettings.mockClear();
    mockGetDatabase.mockClear();

    const throttled = await POST(tokenRequest('203.0.113.1'), {
      params: Promise.resolve({ tenantId: TENANT }),
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await throttled.json()).toMatchObject({ error: 'slow_down' });
    expect(mockGetOrgSettings).not.toHaveBeenCalled();
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('keeps a different address on its own budget', async () => {
    for (let i = 0; i < 61; i += 1) {
      await POST(tokenRequest('203.0.113.1'), { params: Promise.resolve({ tenantId: TENANT }) });
    }
    const other = await POST(tokenRequest('203.0.113.2'), {
      params: Promise.resolve({ tenantId: TENANT }),
    });
    expect(other.status).not.toBe(429);
  });
});
