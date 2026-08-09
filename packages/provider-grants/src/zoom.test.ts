/**
 * The adapter's contract with the orchestrator: GRANT_REVOKED exactly when
 * Zoom says invalid_grant, REFRESH_FAILED for everything else — plus Zoom's
 * two quirks: Basic client auth and rotating refresh tokens.
 */

import { ZoomAdapter } from './zoom';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ZoomAdapter.refreshTokens', () => {
  it('returns the ROTATED refresh token on success', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(200, { access_token: 'new-access', refresh_token: 'rotated', expires_in: 60 })
      );

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.accessToken).toBe('new-access');
      expect(result.val.refreshToken).toBe('rotated');
      expect(result.val.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('falls back to the old refresh token when the response omits one', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { access_token: 'new-access', expires_in: 60 }));

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.refreshToken).toBe('refresh-1');
  });

  it('authenticates the app with HTTP Basic, not body credentials', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 })
      );

    await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://zoom.us/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          // Golden value: base64('client-1:secret').
          Authorization: 'Basic Y2xpZW50LTE6c2VjcmV0',
        }),
      })
    );
    const init = fetchSpy.mock.calls[0][1];
    expect(String(init?.body)).toBe('grant_type=refresh_token&refresh_token=refresh-1');
  });

  it('reports GRANT_REVOKED for an explicit invalid_grant error', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRANT_REVOKED');
  });

  it('reports GRANT_REVOKED when invalid_grant arrives in the reason field', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, { reason: 'invalid_grant' }));

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRANT_REVOKED');
  });

  it('treats ambiguous reasons as REFRESH_FAILED, never revoked', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(400, { reason: 'Invalid Token!' }));

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });

  it('reports other non-2xx responses as REFRESH_FAILED', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, { error: 'server_error' }));

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });

  it('reports network failures as REFRESH_FAILED', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const result = await new ZoomAdapter('secret').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
  });

  it('fails without calling the endpoint when the client secret is missing', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await new ZoomAdapter('').refreshTokens('client-1', 'refresh-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('REFRESH_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
