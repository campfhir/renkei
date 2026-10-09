/**
 * Dynamic client registration is open by specification and writes a row per
 * call, so its throttle is what stops it being a client-row factory: the
 * eleventh registration from one address inside ten minutes is refused
 * before settings or the database are read.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(),
  DEFAULT_ORG_SETTINGS: { enableDcr: false },
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function registration(redirectUris = ['https://client.example/cb']): NextRequest {
  return new NextRequest(`http://localhost/api/mcp/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
    body: JSON.stringify({ client_name: 'c', redirect_uris: redirectUris }),
  });
}

describe('POST /api/mcp/{tenantId}/oauth/register policy', () => {
  beforeEach(() => {
    resetInboundLimits();
    mockGetOrgSettings.mockReset().mockResolvedValue({ ok: true, val: { enableDcr: true } });
    mockGetDatabase.mockReset().mockReturnValue({ ok: false, err: 'DB_ERROR' });
  });

  it('is closed when the org has not turned registration on', async () => {
    mockGetOrgSettings.mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    const response = await POST(registration(), { params: Promise.resolve({ }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'unsupported_operation' });
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('refuses plain http off the loopback before reading the database', async () => {
    const response = await POST(registration(['http://attacker.example/cb']), {
      params: Promise.resolve({ }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_redirect_uri',
      error_description: expect.stringMatching(/redirect_uris\[0\] must use https/),
    });
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('lets a local app register a loopback callback', async () => {
    const response = await POST(registration(['http://127.0.0.1:52341/callback']), {
      params: Promise.resolve({ }),
    });
    // The body passed; only the (deliberately failing) database stopped it.
    expect(response.status).toBe(500);
    expect(mockGetDatabase).toHaveBeenCalled();
  });
});

describe('POST /api/mcp/{tenantId}/oauth/register throttle', () => {
  beforeEach(() => {
    resetInboundLimits();
    mockGetOrgSettings.mockReset().mockResolvedValue({ ok: true, val: { enableDcr: true } });
    mockGetDatabase.mockReset().mockReturnValue({ ok: false, err: 'DB_ERROR' });
  });

  it('refuses the eleventh registration from one address before reading anything', async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(registration(), {
        params: Promise.resolve({ }),
      });
      expect(response.status).not.toBe(429);
    }
    mockGetOrgSettings.mockClear();
    mockGetDatabase.mockClear();

    const throttled = await POST(registration(), { params: Promise.resolve({ }) });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(mockGetOrgSettings).not.toHaveBeenCalled();
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});
