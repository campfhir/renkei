/**
 * DNS TXT proof that whoever created a tenant controls its email domain
 * (migration 146, api/tenant/[tenantId]/verify-domain).
 *
 * Self-service onboarding mints a tenant for any domain nobody has claimed
 * yet, and the sign-in page routes that domain's addresses to the tenant.
 * Without proof of control, the first person to type a domain owned it —
 * a squatter could claim a company's domain and receive its employees'
 * sign-in attempts. The proof is the oldest one there is: publish a token
 * we chose where only the domain's owner can, then let us read it back.
 *
 * The record is `renkei-verify=<token>` in the TXT set of the domain
 * itself (so `example.com. TXT "renkei-verify=…"`), alongside whatever SPF
 * or site-verification records already live there. The resolver is a
 * parameter so the check is testable without a network and so a future
 * caller can supply a resolver with its own timeout.
 */

import { promises as dns } from 'node:dns';
import { timingSafeEqual } from 'node:crypto';

export const VERIFY_RECORD_PREFIX = 'renkei-verify=';

/** The TXT record an organization publishes, as shown in onboarding. */
export function verificationRecord(token: string): string {
  return `${VERIFY_RECORD_PREFIX}${token}`;
}

/** TXT lookups return each record as an array of character-string chunks. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

export const defaultTxtResolver: TxtResolver = (hostname) => dns.resolveTxt(hostname);

export type DomainVerification =
  { verified: true } | { verified: false; reason: 'no-record' | 'wrong-token' | 'lookup-failed' };

/**
 * Whether the domain's TXT set carries `renkei-verify=<expected>`. A record
 * set that has renkei-verify entries but not ours is reported apart from
 * no entry at all, so the onboarding page can say "stale token" rather than
 * "not published".
 */
export async function verifyDomainOwnership(
  domain: string,
  expectedToken: string,
  resolve: TxtResolver = defaultTxtResolver
): Promise<DomainVerification> {
  let records: string[][];
  try {
    records = await resolve(domain);
  } catch (error) {
    // ENOTFOUND / ENODATA mean the set is empty; anything else is a lookup
    // problem the caller can retry.
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { verified: false, reason: 'no-record' };
    return { verified: false, reason: 'lookup-failed' };
  }
  const expected = Buffer.from(verificationRecord(expectedToken), 'utf8');
  let sawPrefix = false;
  for (const chunks of records) {
    const value = chunks.join('').trim();
    if (!value.startsWith(VERIFY_RECORD_PREFIX)) continue;
    sawPrefix = true;
    const presented = Buffer.from(value, 'utf8');
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
      return { verified: true };
    }
  }
  return { verified: false, reason: sawPrefix ? 'wrong-token' : 'no-record' };
}
