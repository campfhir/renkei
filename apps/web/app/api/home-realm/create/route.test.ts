jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/email-sanitizer', () => ({ seedDefaultClassifierRules: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { FREE_EMAIL_DOMAIN_ERROR } from '@/lib/free-email-domains';
import { sha256Hex } from '@renkei/crypto';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { seedDefaultClassifierRules: mockSeed } = jest.requireMock<{
  seedDefaultClassifierRules: jest.Mock;
}>('@renkei/email-sanitizer');

function stubDb(existing: { } | undefined = undefined) {
  const inserted: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    selectFrom() {
      return {
        select() {
          return this;
        },
        where() {
          return this;
        },
        async executeTakeFirst() {
          return existing;
        },
      };
    },
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

function requestWith(domain: string): NextRequest {
  return new NextRequest('http://localhost/api/home-realm/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
}

describe('POST /api/home-realm/create', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockSeed.mockReset().mockResolvedValue({ ok: true });
    resetInboundLimits();
  });

  it.each(['gmail.com', 'YAHOO.com', 'outlook.com', 'hotmail.com', 'icloud.com'])(
    'rejects a free email domain (%s) without ever touching the database',
    async (domain) => {
      const response = await POST(requestWith(domain));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe(FREE_EMAIL_DOMAIN_ERROR);
      expect(mockGetDatabase).not.toHaveBeenCalled();
    }
  );

  it('creates a tenant for a normal company domain', async () => {
    const { inserted } = stubDb();
    const response = await POST(requestWith('acme.com'));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.alreadyExists).toBe(false);
    expect(inserted.find((i) => i.table === 'tenant_domains')?.values.domain).toBe('acme.com');
  });

  it('hands the creator a one-time secret and a TXT record, storing only the digest', async () => {
    const { inserted } = stubDb();
    const response = await POST(requestWith('acme.com'));
    const body = await response.json();
    const tenantRow = inserted.find((i) => i.table === 'tenants')?.values ?? {};

    expect(typeof body.bootstrapSecret).toBe('string');
    expect(body.bootstrapSecret.length).toBeGreaterThanOrEqual(32);
    expect(tenantRow.bootstrap_secret_hash).toBe(sha256Hex(body.bootstrapSecret));
    expect(tenantRow.bootstrap_secret_hash).not.toBe(body.bootstrapSecret);
    expect(new Date(String(tenantRow.bootstrap_secret_expires_at)).getTime()).toBeGreaterThan(
      Date.now()
    );

    expect(body.domainVerification).toEqual({
      domain: 'acme.com',
      recordType: 'TXT',
      record: `renkei-verify=${tenantRow.domain_verification_token}`,
    });
    // Not routable from the sign-in page until the record is seen.
    expect(tenantRow.domain_verified_at).toBeNull();
  });

  it('tells an anonymous caller a claimed domain is taken without naming its tenant', async () => {
    const { inserted } = stubDb({ });
    const response = await POST(requestWith('acme.com'));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.alreadyExists).toBe(true);
    expect().toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(inserted).toHaveLength(0);
  });
});
