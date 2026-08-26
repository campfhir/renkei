/**
 * Kysely accessors for shares, grants and rules — the only file that knows
 * the table shapes. Everything returns Result and every uncertain outcome
 * denies: a DB error is an error (not "no rules"), a rule row whose access
 * value fails validation poisons the whole context rather than being
 * skipped (a skipped row might have been the deny), and a missing grant is
 * a null context, which callers must treat as "this share does not exist
 * for you".
 *
 * getAclContext carries a short TTL cache because every tool call and REST
 * request evaluates it: 15 seconds bounds how long an admin's narrowing can
 * lag on other processes, while same-process admin mutations call
 * clearFileShareCache() and take effect immediately. Only successes are
 * cached — an error remembered as "denied" would heal on its own, but an
 * error remembered as a context would not.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isAccessLevel, isShareProtocol } from './types';
import { isBoundaryPrefix } from './paths';
import type { AccessLevel, AclContext, PathRule, ShareGrant, ShareSummary } from './types';

export type StoreError = 'DB_ERROR' | 'MALFORMED_ROW';

export interface ShareRow {
  summary: ShareSummary;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GrantRow {
  shareId: string;
  subject: string;
  defaultAccess: AccessLevel;
  createdBy: string;
  createdAt: Date;
}

export interface RuleRow extends PathRule {
  id: string;
  shareId: string;
  /** null = the share-wide layer. */
  subject: string | null;
  createdBy: string;
}

interface RawShare {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  share_name: string | null;
  root_path: string;
  case_insensitive: boolean;
  max_access: string;
  enabled: boolean;
  encrypted_credentials: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryFromRow(row: RawShare): ShareSummary | null {
  if (!isShareProtocol(row.protocol)) return null;
  if (row.max_access !== 'read' && row.max_access !== 'read_write') return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    shareName: row.share_name,
    rootPath: row.root_path,
    caseInsensitive: row.case_insensitive,
    maxAccess: row.max_access,
    enabled: row.enabled,
    hasCredentials: row.encrypted_credentials !== null,
  };
}

/**
 * The availability question the MCP transport asks on every connection:
 * does this subject hold ANY grant on an enabled share? Row existence, not
 * level — a grant defaulting to 'none' with one carve-in rule still counts.
 */
export async function hasAnyGrant(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<boolean, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_grants')
        .innerJoin('file_shares', 'file_shares.id', 'file_share_grants.share_id')
        .select('file_share_grants.share_id')
        .where('file_share_grants.tenant_id', '=', tenantId)
        .where('file_share_grants.subject', '=', subject)
        .where('file_shares.enabled', '=', true)
        .limit(1)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return ok(row.val !== undefined);
}

export interface GrantedShare {
  share: ShareSummary;
  grant: ShareGrant;
  /** Whether either rule layer has rows — "path rules apply" in listings. */
  hasRules: boolean;
}

/** Every enabled share this subject may see, with their grant and a rules hint. */
export async function listGrantedShares(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<GrantedShare[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_grants')
        .innerJoin('file_shares', 'file_shares.id', 'file_share_grants.share_id')
        .select([
          'file_shares.id',
          'file_shares.name',
          'file_shares.protocol',
          'file_shares.host',
          'file_shares.port',
          'file_shares.share_name',
          'file_shares.root_path',
          'file_shares.case_insensitive',
          'file_shares.max_access',
          'file_shares.enabled',
          'file_shares.encrypted_credentials',
          'file_share_grants.default_access',
        ])
        .where('file_share_grants.tenant_id', '=', tenantId)
        .where('file_share_grants.subject', '=', subject)
        .where('file_shares.enabled', '=', true)
        .orderBy('file_shares.name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const shareIds = rows.val.map((row) => row.id);
  const ruleCounts = new Set<string>();
  if (shareIds.length > 0) {
    const ruleRows = await wrapAsync(
      () =>
        db
          .selectFrom('file_share_path_rules')
          .select('share_id')
          .distinct()
          .where('tenant_id', '=', tenantId)
          .where('share_id', 'in', shareIds)
          .where((eb) => eb.or([eb('subject', 'is', null), eb('subject', '=', subject)]))
          .execute(),
      'DB_ERROR' as const
    );
    if (!ruleRows.ok) return ruleRows;
    for (const row of ruleRows.val) ruleCounts.add(row.share_id);
  }

  const granted: GrantedShare[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRow(row);
    if (!summary || !isAccessLevel(row.default_access)) return err('MALFORMED_ROW' as const);
    granted.push({
      share: summary,
      grant: { subject, defaultAccess: row.default_access },
      hasRules: ruleCounts.has(row.id),
    });
  }
  return ok(granted);
}

interface AclCacheEntry {
  value: AclContext | null;
  expiresAt: number;
}

const aclCache = new Map<string, AclCacheEntry>();

/** How long one process serves a cached ACL context before re-reading. */
export const ACL_CACHE_TTL_MS = 15_000;

/** Drop cached ACL contexts — called by admin mutations and tests. */
export function clearFileShareCache(): void {
  aclCache.clear();
}

/**
 * Everything the evaluator needs for one (share, subject), or null when the
 * share is not discoverable for that subject — no share, or no grant row.
 */
export async function getAclContext(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string
): Promise<Result<AclContext | null, StoreError>> {
  const cacheKey = `${tenantId}:${shareId}:${subject}`;
  const cached = aclCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);

  const result = await readAclContext(db, tenantId, shareId, subject);
  if (result.ok) {
    aclCache.set(cacheKey, { value: result.val, expiresAt: Date.now() + ACL_CACHE_TTL_MS });
  }
  return result;
}

async function readAclContext(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string
): Promise<Result<AclContext | null, StoreError>> {
  const joined = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_grants')
        .innerJoin('file_shares', 'file_shares.id', 'file_share_grants.share_id')
        .select([
          'file_shares.id',
          'file_shares.name',
          'file_shares.protocol',
          'file_shares.host',
          'file_shares.port',
          'file_shares.share_name',
          'file_shares.root_path',
          'file_shares.case_insensitive',
          'file_shares.max_access',
          'file_shares.enabled',
          'file_shares.encrypted_credentials',
          'file_share_grants.default_access',
        ])
        .where('file_share_grants.tenant_id', '=', tenantId)
        .where('file_share_grants.share_id', '=', shareId)
        .where('file_share_grants.subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!joined.ok) return joined;
  if (!joined.val) return ok(null);

  const summary = summaryFromRow(joined.val);
  if (!summary || !isAccessLevel(joined.val.default_access)) {
    return err('MALFORMED_ROW' as const);
  }

  const ruleRows = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_path_rules')
        .select(['subject', 'path', 'access'])
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where((eb) => eb.or([eb('subject', 'is', null), eb('subject', '=', subject)]))
        .execute(),
    'DB_ERROR' as const
  );
  if (!ruleRows.ok) return ruleRows;

  const shareRules: PathRule[] = [];
  const userRules: PathRule[] = [];
  for (const row of ruleRows.val) {
    // A rule that fails validation poisons the context: skipping it could
    // drop a deny, and guessing at it could invent one.
    if (!isAccessLevel(row.access)) return err('MALFORMED_ROW' as const);
    (row.subject === null ? shareRules : userRules).push({ path: row.path, access: row.access });
  }

  return ok({
    share: summary,
    grant: { subject, defaultAccess: joined.val.default_access },
    shareRules,
    userRules,
  });
}

/** The stored credential ciphertext, for callers about to open a backend. */
export async function readCredentialCiphertext(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('file_shares')
        .select('encrypted_credentials')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return ok(row.val?.encrypted_credentials ?? null);
}

/**
 * Every rule path — ANY layer, ANY subject — anchored at or strictly under
 * `path`. This is the move/rename/delete guard's question, and it must span
 * all subjects: the caller's AclContext only carries their own layers, but
 * moving a folder would slide OTHER users' rules off their targets too
 * (rules govern paths, not objects). A non-empty answer means the operation
 * is refused until an admin removes those rules.
 */
export async function listRulePathsUnder(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  path: string,
  caseInsensitive: boolean
): Promise<Result<string[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_path_rules')
        .select('path')
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;
  const anchored = new Set<string>();
  for (const row of rows.val) {
    if (isBoundaryPrefix(path, row.path, caseInsensitive)) anchored.add(row.path);
  }
  return ok([...anchored].sort());
}

// ---------------------------------------------------------------------------
// Admin accessors — used only behind ROLE_OPERATOR routes.
// ---------------------------------------------------------------------------

export async function listShares(
  db: Kysely<DB>,
  tenantId: string
): Promise<Result<ShareRow[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_shares')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const shares: ShareRow[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRow(row);
    if (!summary) return err('MALFORMED_ROW' as const);
    shares.push({
      summary,
      settings: isRecord(row.settings) ? { ...row.settings } : {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }
  return ok(shares);
}

export async function getShare(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string
): Promise<Result<ShareRow | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('file_shares')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  if (!row.val) return ok(null);
  const summary = summaryFromRow(row.val);
  if (!summary) return err('MALFORMED_ROW' as const);
  return ok({
    summary,
    settings: isRecord(row.val.settings) ? { ...row.val.settings } : {},
    createdAt: new Date(row.val.created_at),
    updatedAt: new Date(row.val.updated_at),
  });
}

export interface ShareInput {
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  port: number | null;
  shareName: string | null;
  rootPath: string;
  caseInsensitive: boolean;
  maxAccess: 'read' | 'read_write';
  enabled: boolean;
}

export async function createShare(
  db: Kysely<DB>,
  tenantId: string,
  input: ShareInput,
  encryptedCredentials: string | null
): Promise<Result<string, StoreError | 'DUPLICATE_NAME'>> {
  const inserted = await wrapAsync(
    () =>
      db
        .insertInto('file_shares')
        .values({
          tenant_id: tenantId,
          name: input.name,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          share_name: input.shareName,
          root_path: input.rootPath,
          case_insensitive: input.caseInsensitive,
          max_access: input.maxAccess,
          enabled: input.enabled,
          encrypted_credentials: encryptedCredentials,
          settings: JSON.stringify({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    'DB_ERROR' as const
  );
  if (!inserted.ok) {
    return isDuplicateName(inserted.err.cause) ? err('DUPLICATE_NAME' as const) : inserted;
  }
  clearFileShareCache();
  return ok(inserted.val.id);
}

export async function updateShare(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  input: ShareInput,
  /** undefined = keep the stored credential; a value replaces it. */
  encryptedCredentials: string | undefined
): Promise<Result<boolean, StoreError | 'DUPLICATE_NAME'>> {
  const updated = await wrapAsync(
    () =>
      db
        .updateTable('file_shares')
        .set({
          name: input.name,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          share_name: input.shareName,
          root_path: input.rootPath,
          case_insensitive: input.caseInsensitive,
          max_access: input.maxAccess,
          enabled: input.enabled,
          ...(encryptedCredentials !== undefined
            ? { encrypted_credentials: encryptedCredentials }
            : {}),
          updated_at: new Date().toISOString(),
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!updated.ok) {
    return isDuplicateName(updated.err.cause) ? err('DUPLICATE_NAME' as const) : updated;
  }
  clearFileShareCache();
  return ok(updated.val.numUpdatedRows > BigInt(0));
}

export async function deleteShare(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('file_shares')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  clearFileShareCache();
  return ok(deleted.val.numDeletedRows > BigInt(0));
}

function isDuplicateName(cause: unknown): boolean {
  return (
    isRecord(cause) &&
    cause.code === '23505' &&
    typeof cause.constraint === 'string' &&
    cause.constraint === 'idx_file_shares_tenant_name'
  );
}

export async function listGrants(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string
): Promise<Result<GrantRow[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_grants')
        .select(['share_id', 'subject', 'default_access', 'created_by', 'created_at'])
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .orderBy('subject')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const grants: GrantRow[] = [];
  for (const row of rows.val) {
    if (!isAccessLevel(row.default_access)) return err('MALFORMED_ROW' as const);
    grants.push({
      shareId: row.share_id,
      subject: row.subject,
      defaultAccess: row.default_access,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
    });
  }
  return ok(grants);
}

export async function upsertGrant(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string,
  defaultAccess: AccessLevel,
  createdBy: string
): Promise<Result<void, StoreError>> {
  const result = await wrapAsync(
    () =>
      db
        .insertInto('file_share_grants')
        .values({
          tenant_id: tenantId,
          share_id: shareId,
          subject,
          default_access: defaultAccess,
          created_by: createdBy,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'share_id', 'subject']).doUpdateSet({
            default_access: defaultAccess,
            updated_at: new Date().toISOString(),
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  clearFileShareCache();
  return ok();
}

/** Deleting a grant cascades that subject's rules via the composite FK. */
export async function deleteGrant(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('file_share_grants')
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  clearFileShareCache();
  return ok(deleted.val.numDeletedRows > BigInt(0));
}

export async function listRules(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  /** null = the share-wide layer. */
  subject: string | null
): Promise<Result<RuleRow[], StoreError>> {
  const rows = await wrapAsync(() => {
    let query = db
      .selectFrom('file_share_path_rules')
      .select(['id', 'share_id', 'subject', 'path', 'access', 'created_by'])
      .where('tenant_id', '=', tenantId)
      .where('share_id', '=', shareId);
    query =
      subject === null ? query.where('subject', 'is', null) : query.where('subject', '=', subject);
    return query.orderBy('path').execute();
  }, 'DB_ERROR' as const);
  if (!rows.ok) return rows;

  const rules: RuleRow[] = [];
  for (const row of rows.val) {
    if (!isAccessLevel(row.access)) return err('MALFORMED_ROW' as const);
    rules.push({
      id: row.id,
      shareId: row.share_id,
      subject: row.subject,
      path: row.path,
      access: row.access,
      createdBy: row.created_by,
    });
  }
  return ok(rules);
}

export async function upsertRule(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string | null,
  path: string,
  access: AccessLevel,
  createdBy: string
): Promise<Result<void, StoreError>> {
  // The layer uniqueness lives in an expression index (coalesce(subject,'')),
  // which ON CONFLICT cannot target by column list — so upsert is a manual
  // update-then-insert. The race window between them is closed by the index
  // itself: a losing insert errors instead of duplicating.
  const updated = await wrapAsync(() => {
    let query = db
      .updateTable('file_share_path_rules')
      .set({ access, updated_at: new Date().toISOString() })
      .where('tenant_id', '=', tenantId)
      .where('share_id', '=', shareId)
      .where('path', '=', path);
    query =
      subject === null ? query.where('subject', 'is', null) : query.where('subject', '=', subject);
    return query.executeTakeFirst();
  }, 'DB_ERROR' as const);
  if (!updated.ok) return updated;

  if (updated.val.numUpdatedRows === BigInt(0)) {
    const inserted = await wrapAsync(
      () =>
        db
          .insertInto('file_share_path_rules')
          .values({
            tenant_id: tenantId,
            share_id: shareId,
            subject,
            path,
            access,
            created_by: createdBy,
          })
          .execute(),
      'DB_ERROR' as const
    );
    if (!inserted.ok) return inserted;
  }
  clearFileShareCache();
  return ok();
}

export async function deleteRule(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  ruleId: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('file_share_path_rules')
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where('id', '=', ruleId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  clearFileShareCache();
  return ok(deleted.val.numDeletedRows > BigInt(0));
}
