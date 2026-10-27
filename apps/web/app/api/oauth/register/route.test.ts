jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(),
  DEFAULT_ORG_SETTINGS: { enableDcr: false },
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type NewOAuthClient,
} from '@renkei/db';
import { POST } from './route';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';

const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);

/**
 * A memory data store recording every client registration, which is the
 * one write this route makes; the client also lands in the store, so the
 * success test can read it back.
 */
function stubStore() {
  const inserted: NewOAuthClient[] = [];
  const store = createMemoryDataStore();
  registerDataStore({
    ...store,
    oauthConsents: {
      ...store.oauthConsents,
      registerClient: (client) => {
        inserted.push(client);
        return store.oauthConsents.registerClient(client);
      },
    },
  });
  return { inserted, store };
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
    mockGetOrgSettings.mockReset().mockResolvedValue({ ok: true, val: { enableDcr: true } });
    resetInboundLimits();
  });

  afterEach(() => resetDataStore());

  it("honours the organization's registration setting", async () => {
    const { inserted } = stubStore();
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { enableDcr: false } });
    const response = await POST(requestWith());
    expect(response.status).toBe(403);
    expect(mockGetOrgSettings).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a redirect URI the policy refuses before touching the database', async () => {
    const { inserted } = stubStore();
    const response = await POST(
      requestWith({ redirectUris: ['http://attacker.example/callback'] })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/must use https/);
    expect(inserted).toHaveLength(0);
  });

  it('refuses the eleventh registration from one address in ten minutes before the database', async () => {
    const { inserted } = stubStore();
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(requestWith());
      expect(response.status).not.toBe(429);
    }
    inserted.length = 0;

    const throttled = await POST(requestWith());
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(inserted).toHaveLength(0);
  });

  it('registers the client', async () => {
    const { inserted, store } = stubStore();
    const response = await POST(requestWith());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_id).toMatch(/^client_/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].clientId).toBe(body.client_id);
    expect(inserted[0].clientSecretHash).not.toBe(body.client_secret);
    const stored = await store.oauthConsents.getClient(body.client_id);
    expect(stored?.clientName).toBe('Test Client');
    expect(stored?.redirectUris).toEqual(['https://client.example/callback']);
  });
});
