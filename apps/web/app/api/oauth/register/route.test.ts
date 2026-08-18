jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';

// Fetched through requireMock rather than the typed import: these stubs
// stand in for a Kysely instance, which cannot be satisfied structurally,
// and the codebase bans type assertions.
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

const REAL_TENANT = '00000000-0000-4000-8000-000000000001';

/**
 * A minimal chainable Kysely stand-in covering exactly the two query shapes
 * this route issues: a `tenants` existence check and an `oauth_clients`
 * insert. Recording the insert's values is what lets the success test
 * confirm the client actually lands under the Referer-named tenant.
 */
function stubDb(tenantRow: { id: string } | undefined) {
  const inserted: { table: string; values: Record<string, unknown> }[] = [];
  const selectChain = {
    select() {
      return selectChain;
    },
    where() {
      return selectChain;
    },
    async executeTakeFirst() {
      return tenantRow;
    },
  };
  const db = {
    selectFrom() {
      return selectChain;
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
 * This system-level route used to fall back to a hardcoded all-zero
 * "system tenant" when it couldn't resolve one from the Referer header —
 * except nothing ever seeds that tenant, so the fallback was not a fallback
 * at all, it was a guaranteed "Tenant not found" for every caller that
 * reached it (the exact symptom a spec-compliant DCR client hits when it
 * registers at this endpoint instead of the tenant-scoped one). What's
 * pinned here: no tenant ever resolves to that UUID, and an unresolved
 * tenant is now an actionable error instead of a doomed lookup.
 */
describe('POST /api/oauth/register (system-level)', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
  });

  it('rejects with an actionable error when no tenant can be resolved', async () => {
    stubDb(undefined);
    const response = await POST(requestWith());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('Could not determine which tenant');
    // The historical bug: confirm the fake fallback tenant is gone entirely,
    // not just unreachable.
    expect(body.error_description).not.toContain('00000000-0000-0000-0000-000000000000');
  });

  it('rejects when the Referer names a tenant that does not exist', async () => {
    stubDb(undefined);
    const response = await POST(
      requestWith({ referer: `http://localhost/api/mcp/${REAL_TENANT}/http` })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error_description).toBe('Tenant not found');
  });

  it('registers the client under the tenant the Referer names', async () => {
    const { inserted } = stubDb({ id: REAL_TENANT });
    const response = await POST(
      requestWith({ referer: `http://localhost/api/mcp/${REAL_TENANT}/http` })
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_id).toMatch(/^client_/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe('oauth_clients');
    expect(inserted[0].values.tenant_id).toBe(REAL_TENANT);
  });
});
