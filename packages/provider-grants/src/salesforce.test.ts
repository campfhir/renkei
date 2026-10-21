/**
 * The adapter's contract with the orchestrator: GRANT_REVOKED exactly when
 * Salesforce says invalid_grant, REFRESH_FAILED for everything else — plus
 * Salesforce's shapes: the org's own token endpoint, no expires_in, and a
 * refresh token that rotates only when the org turns rotation on.
 */

import {
  SalesforceAdapter,
  SALESFORCE_SESSION_SECONDS,
  readSalesforceMetadata,
  salesforceRevokeEndpoint,
  salesforceTokenEndpoint,
} from './salesforce';

const ENDPOINT = 'https://acme.my.salesforce.com/services/oauth2/token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SalesforceAdapter.refreshTokens', () => {
  it("posts to the org's own token endpoint and keeps the refresh token", async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        access_token: 'new-access',
        instance_url: 'https://acme.my.salesforce.com',
        issued_at: '1760000000000',
      })
    );

    const before = Date.now();
    const result = await new SalesforceAdapter('secret', ENDPOINT).refreshTokens(
      'client-1',
      'refresh-1'
    );

    expect(fetchSpy).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ method: 'POST' }));
    const body = String(fetchSpy.mock.calls[0][1]?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_secret=secret');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.accessToken).toBe('new-access');
      expect(result.val.refreshToken).toBe('refresh-1');
      // No expires_in: the conservative session length.
      expect(result.val.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + SALESFORCE_SESSION_SECONDS * 1000
      );
    }
  });

  it('takes a rotated refresh token when the org sends one', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { access_token: 'a', refresh_token: 'rotated' }));
    const result = await new SalesforceAdapter('secret', ENDPOINT).refreshTokens('c', 'r');
    expect(result.ok && result.val.refreshToken).toBe('rotated');
  });

  it('reads invalid_grant as revoked, other failures as transient', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: 'invalid_grant',
          error_description: 'expired access/refresh token',
        })
      )
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_client_id' }));
    const adapter = new SalesforceAdapter('secret', ENDPOINT);

    const revoked = await adapter.refreshTokens('c', 'r');
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.err.type).toBe('GRANT_REVOKED');

    const misconfigured = await adapter.refreshTokens('c', 'r');
    expect(misconfigured.ok).toBe(false);
    if (!misconfigured.ok) expect(misconfigured.err.type).toBe('REFRESH_FAILED');
  });

  it('refuses without a secret or endpoint, before dialing', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await new SalesforceAdapter('', ENDPOINT).refreshTokens('c', 'r');
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('endpoints and metadata', () => {
  it('derives endpoints from the My Domain origin', () => {
    expect(salesforceTokenEndpoint('https://acme.my.salesforce.com/')).toBe(ENDPOINT);
    expect(salesforceRevokeEndpoint('https://acme.my.salesforce.com')).toBe(
      'https://acme.my.salesforce.com/services/oauth2/revoke'
    );
  });

  it('trims any run of trailing slashes in linear time', () => {
    expect(salesforceTokenEndpoint('https://acme.my.salesforce.com///')).toBe(ENDPOINT);
    // A long run of slashes not at the end is where /\/+$/ backtracked.
    const started = Date.now();
    salesforceTokenEndpoint(`https://acme.my.salesforce.com${'/'.repeat(50_000)}x`);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('reads metadata defensively', () => {
    expect(
      readSalesforceMetadata({ orgId: '00D', userId: '005', instanceUrl: 'x', username: 7 })
    ).toEqual({
      orgId: '00D',
      userId: '005',
      instanceUrl: 'x',
      username: '',
    });
  });
});
