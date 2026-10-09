/**
 * Domain verification for onboarding (migration 146): the verified
 * timestamp is written only when DNS carries the tenant's own
 * renkei-verify token, and a caller learns nothing more than whether it
 * does yet.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/domain-verification', () => {
  const actual: typeof import('@/lib/domain-verification') = jest.requireActual(
    '@/lib/domain-verification'
  );
  return { ...actual, verifyDomainOwnership: jest.fn() };
});

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { verifyDomainOwnership: mockVerify } = jest.requireMock<{
  verifyDomainOwnership: jest.Mock;
}>('@/lib/domain-verification');

const TENANT = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'tok3n';

function stubDb(tenant: Record<string, unknown> | undefined, domains: string[] = ['acme.com']) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    selectFrom(table: string) {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => (table === 'tenants' ? tenant : undefined),
        execute: async () => domains.map((domain) => ({ domain })),
      };
      return chain;
    },
    updateTable() {
      const chain = {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return chain;
        },
        where: () => chain,
        execute: async () => undefined,
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { updates };
}

function verifyRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/tenant/${TENANT}/verify-domain`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
}

const context = { params: Promise.resolve({ tenantId: TENANT }) };

describe('POST /api/tenant/{tenantId}/verify-domain', () => {
  beforeEach(() => {
    resetInboundLimits();
    mockGetDatabase.mockReset();
    mockVerify.mockReset();
  });

  it('marks the tenant verified when DNS carries its token', async () => {
    const { updates } = stubDb({
      id: TENANT,
      domain_verification_token: TOKEN,
      domain_verified_at: null,
    });
    mockVerify.mockResolvedValue({ verified: true });

    const response = await POST(verifyRequest(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: true, domain: 'acme.com' });
    expect(mockVerify).toHaveBeenCalledWith('acme.com', TOKEN);
    expect(updates).toHaveLength(1);
    expect(updates[0].domain_verified_at).toBeInstanceOf(Date);
  });

  it('writes nothing and says what record is expected when the token is not published', async () => {
    const { updates } = stubDb({
      id: TENANT,
      domain_verification_token: TOKEN,
      domain_verified_at: null,
    });
    mockVerify.mockResolvedValue({ verified: false, reason: 'no-record' });

    const response = await POST(verifyRequest(), context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.verified).toBe(false);
    expect(body.expected).toEqual({ recordType: 'TXT', record: `renkei-verify=${TOKEN}` });
    expect(body.domains).toEqual([{ domain: 'acme.com', reason: 'no-record' }]);
    expect(updates).toHaveLength(0);
  });

  it('is idempotent for an already-verified tenant without a lookup', async () => {
    stubDb({ id: TENANT, domain_verification_token: TOKEN, domain_verified_at: new Date() });

    const response = await POST(verifyRequest(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: true, alreadyVerified: true });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown tenant', async () => {
    stubDb(undefined);
    const response = await POST(verifyRequest(), context);
    expect(response.status).toBe(404);
  });

  it('throttles repeated attempts before touching the database', async () => {
    stubDb({ id: TENANT, domain_verification_token: TOKEN, domain_verified_at: null });
    mockVerify.mockResolvedValue({ verified: false, reason: 'no-record' });
    for (let i = 0; i < 10; i += 1) await POST(verifyRequest(), context);
    mockGetDatabase.mockClear();

    const response = await POST(verifyRequest(), context);

    expect(response.status).toBe(429);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});
