import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'renkei_operator';

/**
 * Operator session tokens are HMAC-signed. They were previously bare base64 JSON,
 * so anyone could mint `{subject, operator, tenantId, expiresAt}` and hold an
 * operator session on any tenant. The signing key is derived from
 * TOKEN_ENCRYPTION_KEY with a distinct label so it is not the same key used for
 * token encryption at rest.
 */
function signingKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required to sign operator sessions');
  }
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update('renkei-operator-session-v1')
    .digest();
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}
const SIGN_IN_TTL_MS = 15 * 60 * 1000;
const MAX_HOURS = 4;

export interface OperatorSession {
  sessionId: string;
  subject: string;
  operator: string;
  tenantId: string;
  issuedAt: number;
  expiresAt: number;
}

function isOperatorSession(data: unknown): data is OperatorSession {
  if (typeof data !== 'object' || data === null) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.sessionId === 'string' &&
    typeof obj.subject === 'string' &&
    typeof obj.operator === 'string' &&
    typeof obj.tenantId === 'string' &&
    typeof obj.issuedAt === 'number' &&
    typeof obj.expiresAt === 'number'
  );
}

export function createSessionToken(session: Omit<OperatorSession, 'issuedAt'>) {
  const payload = Buffer.from(
    JSON.stringify({
      ...session,
      issuedAt: Date.now(),
    })
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

export function parseSessionToken(token: string): OperatorSession | null {
  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;

    const expected = Buffer.from(sign(payload), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    const now = Date.now();

    // Check if session has expired
    if (!isOperatorSession(data) || data.expiresAt < now) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

export async function setOperatorCookie(session: OperatorSession): Promise<void> {
  const token = createSessionToken(session);
  const maxAge = session.expiresAt - Date.now();

  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: Math.max(0, Math.floor(maxAge / 1000)),
  });
}

export async function getOperatorSession(): Promise<OperatorSession | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  return parseSessionToken(token);
}

export async function clearOperatorCookie(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

export function generateSignInState(): { state: string; nonce: string; codeVerifier: string } {
  return {
    state: randomUUID(),
    nonce: randomUUID(),
    codeVerifier: randomUUID(),
  };
}

export function calculateExpiresAt(): number {
  return Date.now() + MAX_HOURS * 60 * 60 * 1000;
}

export function calculatePendingExpiresAt(): number {
  return Date.now() + SIGN_IN_TTL_MS;
}
