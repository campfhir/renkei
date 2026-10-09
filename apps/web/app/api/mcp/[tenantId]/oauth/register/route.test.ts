/**
 * Dynamic client registration is open by specification and writes a row per
 * call, so its throttle is what stops it being a client-row factory: the
 * eleventh registration from one address inside ten minutes is refused
 * before settings or the database are read.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(),
  DEFAULT_ORG_SETTINGS: { enableDcr: true },
}));

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function registration(): NextRequest {
  return new NextRequest(`http://localhost/api/mcp/${TENANT}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
    body: JSON.stringify({ client_name: 'c', redirect_uris: ['https://client.example/cb'] }),
  });
}

describe('POST /api/mcp/{tenantId}/oauth/register throttle', () => {
  beforeEach(() => {
    resetInboundLimits();
    mockGetOrgSettings.mockReset().mockResolvedValue({ ok: true, val: { enableDcr: true } });
    mockGetDatabase.mockReset().mockReturnValue({ ok: false, err: 'DB_ERROR' });
  });

  it('refuses the eleventh registration from one address before reading anything', async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(registration(), {
        params: Promise.resolve({ tenantId: TENANT }),
      });
      expect(response.status).not.toBe(429);
    }
    mockGetOrgSettings.mockClear();
    mockGetDatabase.mockClear();

    const throttled = await POST(registration(), { params: Promise.resolve({ tenantId: TENANT }) });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(mockGetOrgSettings).not.toHaveBeenCalled();
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});
