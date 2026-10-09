jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { FREE_EMAIL_DOMAIN_ERROR } from '@/lib/free-email-domains';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

function requestWith(email: string): NextRequest {
  return new NextRequest(`http://localhost/api/home-realm?email=${encodeURIComponent(email)}`, {
    method: 'POST',
  });
}

describe('POST /api/home-realm', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
  });

  it.each(['someone@gmail.com', 'someone@YAHOO.com', 'someone@outlook.com'])(
    'rejects a free email domain (%s) without looking up a tenant',
    async (email) => {
      const response = await POST(requestWith(email));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe(FREE_EMAIL_DOMAIN_ERROR);
      expect(mockGetDatabase).not.toHaveBeenCalled();
    }
  );

  it('redirects an unclaimed company domain to create-organization', async () => {
    mockGetDatabase.mockReturnValue({
      ok: true,
      val: {
        selectFrom() {
          return {
            leftJoin() {
              return this;
            },
            where() {
              return this;
            },
            select() {
              return this;
            },
            async executeTakeFirst() {
              return undefined;
            },
          };
        },
      },
    });

    const response = await POST(requestWith('someone@acme.com'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/create-organization?domain=acme.com');
  });

  function stubClaim(row: Record<string, unknown> | undefined) {
    mockGetDatabase.mockReturnValue({
      ok: true,
      val: {
        selectFrom() {
          return {
            leftJoin() {
              return this;
            },
            where() {
              return this;
            },
            select() {
              return this;
            },
            async executeTakeFirst() {
              return row;
            },
          };
        },
      },
    });
  }

  it('routes a verified domain to its tenant', async () => {
    stubClaim({ id: 't1', slug: 'acme', domain_verified_at: new Date() });
    const response = await POST(requestWith('someone@acme.com'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toMatch(/\/acme$/);
  });

  it('never routes to a tenant that has not proven control of the domain', async () => {
    // A squatter's tenant: created for acme.com, TXT record never published.
    stubClaim({ id: 't1', slug: 'acme', domain_verified_at: null });
    const response = await POST(requestWith('someone@acme.com'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/create-organization?domain=acme.com&pending=1');
    expect(location).not.toContain('/acme');
    expect(location).not.toContain('t1');
  });
});
