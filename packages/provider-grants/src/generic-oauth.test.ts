import { GenericOAuthAdapter } from './generic-oauth';

function answer(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('GenericOAuthAdapter', () => {
  it('keeps the old refresh token when the server does not rotate it', async () => {
    const adapter = new GenericOAuthAdapter(
      'mcp:x',
      'https://auth.example/token',
      '',
      'none',
      answer(200, { access_token: 'new', expires_in: 60 })
    );
    const result = await adapter.refreshTokens('client', 'old-refresh');
    expect(result.ok && result.val.accessToken).toBe('new');
    expect(result.ok && result.val.refreshToken).toBe('old-refresh');
  });

  it('presents a public client by id only and a confidential one in the requested style', async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const record: typeof fetch = async (_url, init) => {
      seen.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
    };
    await new GenericOAuthAdapter('p', 'https://a/t', '', 'none', record).refreshTokens('c', 'r');
    await new GenericOAuthAdapter('p', 'https://a/t', 's', 'body', record).refreshTokens('c', 'r');
    await new GenericOAuthAdapter('p', 'https://a/t', 's', 'basic', record).refreshTokens('c', 'r');
    expect(seen[0].body).toContain('client_id=c');
    expect(seen[0].body).not.toContain('client_secret');
    expect(seen[1].body).toContain('client_secret=s');
    expect(seen[2].headers.authorization).toMatch(/^Basic /);
    expect(seen[2].body).not.toContain('client_secret');
  });

  it('deletes the grant only on invalid_grant', async () => {
    const revoked = await new GenericOAuthAdapter(
      'p',
      'https://a/t',
      '',
      'none',
      answer(400, { error: 'invalid_grant' })
    ).refreshTokens('c', 'r');
    const transient = await new GenericOAuthAdapter(
      'p',
      'https://a/t',
      '',
      'none',
      answer(500, { error: 'server_error' })
    ).refreshTokens('c', 'r');
    expect(!revoked.ok && revoked.err.type).toBe('GRANT_REVOKED');
    expect(!transient.ok && transient.err.type).toBe('REFRESH_FAILED');
  });
});
