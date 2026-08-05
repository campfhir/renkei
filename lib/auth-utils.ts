import { randomUUID } from 'crypto';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'renkei_operator';
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
  return typeof obj.sessionId === 'string' && typeof obj.subject === 'string' && typeof obj.operator === 'string' && typeof obj.tenantId === 'string' && typeof obj.issuedAt === 'number' && typeof obj.expiresAt === 'number';
}

export function createSessionToken(session: Omit<OperatorSession, 'issuedAt'>) {
  return Buffer.from(
    JSON.stringify({
      ...session,
      issuedAt: Date.now(),
    })
  ).toString('base64');
}

export function parseSessionToken(token: string): OperatorSession | null {
  try {
    const data = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
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
