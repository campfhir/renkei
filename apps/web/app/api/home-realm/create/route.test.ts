jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/email-sanitizer', () => ({ seedDefaultClassifierRules: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { FREE_EMAIL_DOMAIN_ERROR } from '@/lib/free-email-domains';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { seedDefaultClassifierRules: mockSeed } = jest.requireMock<{
  seedDefaultClassifierRules: jest.Mock;
}>('@renkei/email-sanitizer');

function stubDb() {
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
          return undefined;
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
});
