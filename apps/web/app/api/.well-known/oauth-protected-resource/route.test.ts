import { GET } from './route';

/**
 * Renkei has no system-level protected resource — every MCP endpoint is
 * tenant-scoped, and its 401 challenge already names the tenant-scoped
 * document. Pinning the 404 here keeps a client from being pointed at the
 * (non-functional) system-level authorization server instead of following
 * the challenge it was actually given.
 */
describe('GET /.well-known/oauth-protected-resource (system-level)', () => {
  it('404s, pointing at the WWW-Authenticate challenge / tenant-scoped document', async () => {
    const response = await GET();
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('not_found');
    expect(body.error_description).toContain(
      '/api/mcp/{tenantId}/.well-known/oauth-protected-resource'
    );
  });
});
