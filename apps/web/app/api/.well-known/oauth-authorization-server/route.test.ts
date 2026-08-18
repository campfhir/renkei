import { GET } from './route';

/**
 * This system-level document must never come back to life as a working
 * OAuth AS: its authorize/token endpoints are non-functional (see the
 * route's docblock), so silently serving discoverable metadata for them
 * would route a client into a dead end that looks like success until its
 * first authenticated call. The one behavior worth pinning is that this
 * always 404s and always points a reader at the tenant-scoped equivalent.
 */
describe('GET /.well-known/oauth-authorization-server (system-level)', () => {
  it('404s, pointing at tenant-scoped discovery', async () => {
    const response = await GET();
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('not_found');
    expect(body.error_description).toContain(
      '/api/mcp/{tenantId}/.well-known/oauth-authorization-server'
    );
  });
});
