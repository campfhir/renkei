jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(),
  DEFAULT_ORG_SETTINGS: { enableDcr: false },
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';

// Fetched through requireMock rather than the typed import: these stubs
// stand in for a Kysely instance, which cannot be satisfied structurally,
// and the codebase bans type assertions.
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);

/**
 * A minimal chainable Kysely stand-in covering the one query this route
 * issues: an `oauth_clients` insert. Recording the insert's values is what
 * lets the success test confirm the client actually lands.
 */
function stubDb() {
  const inserted: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    insertInto(table: string) {
      return {
        values(values: Record<string, unknown>) {
          inserted.push({ table, values });
          return { async execute() {} };
        },
      };
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { inserted };
}

function requestWith(options: { referer?: string; redirectUris?: string[] } = {}): NextRequest {
  const { referer, redirectUris = ['https://client.example/callback'] } = options;
  return new NextRequest('http://localhost/api/oauth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(referer ? { referer } : {}),
    },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: redirectUris }),
  });
}

/**
 * Registration consults the organization's own setting; with it off the
 * route refuses before anything is written, and with it on a client row is
 * the only thing it writes.
 */
describe('POST /api/oauth/register (system-level)', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetOrgSettings.mockReset().mockResolvedValue({ ok: true, val: { enableDcr: true } });
    resetInboundLimits();
  });

  it("honours the organization's registration setting", async () => {
    const { inserted } = stubDb();
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { enableDcr: false } });
    const response = await POST(requestWith());
    expect(response.status).toBe(403);
    expect(mockGetOrgSettings).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a redirect URI the policy refuses before touching the database', async () => {
    const { inserted } = stubDb();
    mockGetDatabase.mockClear();
    const response = await POST(
      requestWith({ redirectUris: ['http://attacker.example/callback'] })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/must use https/);
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('refuses the eleventh registration from one address in ten minutes before the database', async () => {
    stubDb();
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(
        requestWith()
      );
      expect(response.status).not.toBe(429);
    }
    mockGetDatabase.mockClear();

    const throttled = await POST(
      requestWith()
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('registers the client', async () => {
    const { inserted } = stubDb();
    const response = await POST(
      requestWith()
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_id).toMatch(/^client_/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe('oauth_clients');
    expect(inserted[0].values.client_id).toBe(body.client_id);
  });
});
