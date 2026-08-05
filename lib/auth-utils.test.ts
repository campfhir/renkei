import { createSessionToken, parseSessionToken } from './auth-utils';

describe('operator session tokens', () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = 'B4KpDl0aVvVOn3f8jXsQ2mKcTt5Hh9wZ1yEeRrUuIiO=';
  });

  afterAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  const session = {
    sessionId: 'sess-1',
    subject: 'user-abc',
    operator: 'Someone',
    tenantId: 'tenant-1',
    expiresAt: Date.now() + 60_000,
  };

  it('round-trips a signed session', () => {
    const parsed = parseSessionToken(createSessionToken(session));
    expect(parsed).not.toBeNull();
    expect(parsed?.subject).toBe('user-abc');
    expect(parsed?.tenantId).toBe('tenant-1');
  });

  it('rejects an unsigned token forged by hand', () => {
    // Exactly the old wire format: base64 JSON with no signature.
    const forged = Buffer.from(
      JSON.stringify({ ...session, operator: 'Attacker', issuedAt: Date.now() })
    ).toString('base64');

    expect(parseSessionToken(forged)).toBeNull();
  });

  it('rejects a token whose payload was edited after signing', () => {
    const token = createSessionToken(session);
    const [, signature] = token.split('.');

    const tampered = Buffer.from(
      JSON.stringify({ ...session, tenantId: 'someone-elses-tenant', issuedAt: Date.now() })
    ).toString('base64url');

    expect(parseSessionToken(`${tampered}.${signature}`)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const token = createSessionToken(session);
    process.env.TOKEN_ENCRYPTION_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo=';
    expect(parseSessionToken(token)).toBeNull();
    process.env.TOKEN_ENCRYPTION_KEY = 'B4KpDl0aVvVOn3f8jXsQ2mKcTt5Hh9wZ1yEeRrUuIiO=';
  });

  it('rejects an expired session', () => {
    const expired = createSessionToken({ ...session, expiresAt: Date.now() - 1000 });
    expect(parseSessionToken(expired)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseSessionToken('')).toBeNull();
    expect(parseSessionToken('nodot')).toBeNull();
    expect(parseSessionToken('.')).toBeNull();
  });
});
