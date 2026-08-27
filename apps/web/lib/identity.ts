/**
 * The identity spine: (tenant, OIDC subject) → email.
 *
 * Renkei's own credentials are subject-bound, but every provider gate
 * verifies access by email — WebEx asks "is this email in the room". The
 * spine records that mapping at the only moment it is trustworthy: OIDC
 * sign-in, from the id_token's claims. It is recorded identity, never
 * authorization — gates still verify live with the provider.
 *
 * A subject with no recorded email fails closed downstream: the knowledge
 * gate discloses nothing it cannot verify, and verification needs the email.
 */

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface IdentityClaims {
  email: string;
  displayName: string | null;
}

/**
 * Pull the identity claims out of a decoded id_token. `email` is the
 * standard claim; Azure AD often carries the address only in
 * `preferred_username`, which is accepted when it looks like one.
 */
export function identityClaimsFromIdToken(decoded: Record<string, unknown>): IdentityClaims | null {
  const email =
    typeof decoded.email === 'string' && decoded.email.includes('@')
      ? decoded.email
      : typeof decoded.preferred_username === 'string' && decoded.preferred_username.includes('@')
        ? decoded.preferred_username
        : null;
  if (!email) return null;
  return {
    email: email.toLowerCase(),
    displayName: typeof decoded.name === 'string' ? decoded.name : null,
  };
}

/** Record (or refresh) who a subject is. Upserted on every sign-in. */
export async function upsertIdentity(
  tenantId: string,
  subject: string,
  claims: IdentityClaims
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('identities')
        .values({
          tenant_id: tenantId,
          subject,
          email: claims.email,
          display_name: claims.displayName,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'subject']).doUpdateSet({
            email: claims.email,
            display_name: claims.displayName,
            updated_at: new Date().toISOString(),
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}

/** The recorded email for a subject, or null when none is on record. */
export async function getIdentityEmail(
  tenantId: string,
  subject: string
): Promise<Result<string | null, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('identities')
        .select('email')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  return ok(rowResult.val?.email ?? null);
}

export interface TenantPerson {
  subject: string;
  email: string;
  displayName: string | null;
}

/**
 * Everyone who has ever signed into this tenant, for pickers (e.g. the
 * agent sharing modal). Recorded identity only — a colleague who has never
 * signed in has no subject yet and cannot be picked, which is correct: a
 * grant is addressed to a subject.
 */
export async function listIdentities(tenantId: string): Promise<TenantPerson[]> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return [];

  const rows = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('identities')
        .select(['subject', 'email', 'display_name'])
        .where('tenant_id', '=', tenantId)
        .orderBy('display_name', 'asc')
        .orderBy('email', 'asc')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return [];
  return rows.val.map((row) => ({
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
  }));
}

/**
 * The recorded identity for a subject, for display: who to show in the nav.
 * Null when the subject has never signed in with claims we could record.
 */
export async function getIdentityDisplay(
  tenantId: string,
  subject: string
): Promise<IdentityClaims | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const row = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('identities')
        .select(['email', 'display_name'])
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok || !row.val) return null;
  return { email: row.val.email, displayName: row.val.display_name };
}
