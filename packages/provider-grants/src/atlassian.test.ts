/**
 * The adapter's contract with the orchestrator: GRANT_REVOKED exactly when
 * the provider says invalid_grant, REFRESH_FAILED for everything else. The
 * orchestrator deletes grants on GRANT_REVOKED, so a wrong verdict here
 * destroys a working authorization.
 */

import { AtlassianAdapter } from './atlassian';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AtlassianAdapter.refreshTokens', () => {
  it('returns refreshed tokens on success', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60 })
    );

    const result = await new AtlassianAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.accessToken).toBe('new-access');
      expect(result.val.refreshToken).toBe('new-refresh');
      expect(result.val.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('reports GRANT_REVOKED only for invalid_grant', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(403, { error: 'invalid_grant' }));

    const result = await new AtlassianAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRANT_REVOKED');
  });

  it('reports transient failures as REFRESH_FAILED, never revoked', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(500, { error: 'server_error' }));

    const result = await new AtlassianAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });

  it('fails without calling the endpoint when the client secret is missing', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await new AtlassianAdapter('').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails when the token response is missing fields', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { access_token: 'only' }));

    const result = await new AtlassianAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });
});
