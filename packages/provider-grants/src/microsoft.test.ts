/**
 * The adapter's contract with the orchestrator: GRANT_REVOKED exactly when
 * Microsoft says invalid_grant, REFRESH_FAILED for everything else — and,
 * because Microsoft rotates refresh tokens, the successor token must come
 * back out of a successful refresh or the grant dies on the next round.
 */

import { MicrosoftAdapter } from './microsoft';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MicrosoftAdapter.refreshTokens', () => {
  it('returns refreshed tokens on success, persisting the rotated refresh token', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 60,
      })
    );

    const result = await new MicrosoftAdapter('secret', 'tenant-1').refreshTokens(
      'client-1',
      'old-refresh'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.accessToken).toBe('new-access');
      expect(result.val.refreshToken).toBe('rotated-refresh');
      expect(result.val.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('refresh_token')).toBe('old-refresh');
  });

  it('falls back to the old refresh token when the response omits one', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { access_token: 'new-access', expires_in: 60 }));

    const result = await new MicrosoftAdapter('secret', 'tenant-1').refreshTokens(
      'client-1',
      'old-refresh'
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.refreshToken).toBe('old-refresh');
  });

  it('reports GRANT_REVOKED only for invalid_grant', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));

    const result = await new MicrosoftAdapter('secret', 'tenant-1').refreshTokens(
      'client-1',
      'refresh-1'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRANT_REVOKED');
  });

  it('reports other 400s as REFRESH_FAILED, never revoked', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(400, { error: 'invalid_client' }));

    const result = await new MicrosoftAdapter('secret', 'tenant-1').refreshTokens(
      'client-1',
      'refresh-1'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });

  it('reports network failures as REFRESH_FAILED', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await new MicrosoftAdapter('secret', 'tenant-1').refreshTokens(
      'client-1',
      'refresh-1'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });

  it('fails without calling the endpoint when the client secret is missing', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await new MicrosoftAdapter('', 'tenant-1').refreshTokens(
      'client-1',
      'refresh-1'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
