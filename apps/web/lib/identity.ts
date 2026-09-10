/**
 * The identity spine: (tenant, OIDC subject) → email, and the IdP groups
 * the person carried at their last sign-in.
 *
 * Renkei's own credentials are subject-bound, but every provider gate
 * verifies access by email — WebEx asks "is this email in the room". The
 * spine records that mapping at the only moment it is trustworthy: OIDC
 * sign-in, from the id_token's claims. It is recorded identity, never
 * authorization — gates still verify live with the provider.
 *
 * Groups are the same kind of fact: what the IdP said, when it said it.
 * Connector audience rules (lib/connectors/audience.ts) read them; nothing
 * here decides what a group may see. They are replaced wholesale on every
 * sign-in, so a group the IdP took away is gone with the next session.
 *
 * A subject with no recorded email fails closed downstream: the knowledge
 * gate discloses nothing it cannot verify, and verification needs the email.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface IdentityClaims {
  email: string;
  displayName: string | null;
  /** Raw values of the tenant's groups claim; empty when the token carried none. */
  idpGroups: string[];
}

/** Bounds on what a token may put in the spine — a claim is not a bulk upload. */
const MAX_GROUPS = 500;
const MAX_GROUP_CHARS = 255;

/**
 * The group values a decoded id_token carries under `claimName`: an array
 * of strings, or one string, deduplicated and bounded. Anything else — a
 * missing claim, an object, numbers — reads as no groups, and the caller
 * decides what that means (fail closed, for audiences).
 */
export function groupValuesFromIdToken(
  decoded: Record<string, unknown>,
  claimName: string
): string[] {
  const raw = decoded[claimName];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_GROUP_CHARS) continue;
    seen.add(trimmed);
    if (seen.size >= MAX_GROUPS) break;
  }
  return [...seen];
}

/**
 * Entra's groups overage: when a person is in more groups than fit in a
 * token, the claim is omitted and `_claim_names.groups` points at Graph
 * instead. Renkei does not follow that pointer, so the person reads as
 * having no groups — audiences fail closed for them, and the sign-in log
 * says why.
 */
export function hasGroupsOverage(decoded: Record<string, unknown>, claimName: string): boolean {
  const names = decoded._claim_names;
  return (
    decoded[claimName] === undefined &&
    typeof names === 'object' &&
    names !== null &&
    claimName in names
  );
}

/**
 * Pull the identity claims out of a decoded id_token. `email` is the
 * standard claim; Azure AD often carries the address only in
 * `preferred_username`, which is accepted when it looks like one.
 * `groupsClaim` names where the groups live (default 'groups').
 */
export function identityClaimsFromIdToken(
  decoded: Record<string, unknown>,
  groupsClaim: string = 'groups'
): IdentityClaims | null {
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
    idpGroups: groupValuesFromIdToken(decoded, groupsClaim),
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
          idp_groups: claims.idpGroups,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'subject']).doUpdateSet({
            email: claims.email,
            display_name: claims.displayName,
            idp_groups: claims.idpGroups,
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

/**
 * The groups a subject carried at their last sign-in. An unknown subject
 * has none. Errors are returned, not swallowed: the audience gate must be
 * able to tell "no groups" from "could not read", because the two fail
 * differently.
 */
export async function idpGroupsFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<string[], 'DB_ERROR'>> {
  const rowResult = await wrapAsync(
    () =>
      db
        .selectFrom('identities')
        .select('idp_groups')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  return ok(rowResult.val?.idp_groups ?? []);
}

/**
 * Every distinct group value seen at sign-in across the tenant, for the
 * audience picker's suggestions. Optional substring filter, bounded — a
 * suggestion list, not an export.
 */
export async function observedIdpGroups(
  db: Kysely<DB>,
  tenantId: string,
  query = '',
  limit = 50
): Promise<string[]> {
  const needle = `%${query.replace(/[%_]/g, '')}%`;
  const rows = await wrapAsync(
    () =>
      sql<{ value: string }>`
        SELECT DISTINCT unnest(idp_groups) AS value
        FROM identities
        WHERE tenant_id = ${tenantId}
        ORDER BY value
      `.execute(db),
    'DB_ERROR' as const
  );
  if (!rows.ok) return [];
  const lowered = needle.slice(1, -1).toLowerCase();
  return rows.val.rows
    .map((row) => row.value)
    .filter((value) => lowered.length === 0 || value.toLowerCase().includes(lowered))
    .slice(0, limit);
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
        .select(['email', 'display_name', 'idp_groups'])
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok || !row.val) return null;
  return {
    email: row.val.email,
    displayName: row.val.display_name,
    idpGroups: row.val.idp_groups ?? [],
  };
}
