/**
 * @renkei/settings — platform and org configuration from the database.
 *
 * The principle (RENKEI.md Decision #19): the environment holds only what is
 * needed before the database can answer — the connection, the root
 * encryption key, process wiring. Everything else is policy, and policy is
 * data: deployment-scoped values in `platform_settings`, org-scoped policy
 * in `tenant_settings`, both read here through typed accessors with explicit
 * defaults and a short cache.
 */

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/** Org-scoped policy (Decision #13: org-admins set defaults and limits). */
export interface OrgSettings {
  /** Org-wide read-only mode: no mutating capability is exposed. */
  readOnly: boolean;
  /**
   * Connector keys switched off org-wide — their tools stop being registered
   * for every user, immediately and without touching anyone's grant.
   *
   * Deliberately separate from the connector's `enabled` flag and from the
   * scope ceiling. Disabling a connector_config stops new CONNECTIONS and
   * narrowing the ceiling forces everyone to reconnect to get a capability
   * back; this only hides tools, so flipping it back on restores them with
   * no user action at all. That makes it the right control for "turn this
   * off for now".
   */
  disabledConnectors: string[];
  /** RFC 7591 dynamic client registration on this org's OAuth server. */
  enableDcr: boolean;
  maxJqlResults: number;
  maxAttachmentBytes: number;
  rateLimitPerUserPerMinute: number;
  accessTokenTtlMinutes: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlDays: number;
  /**
   * Best-effort removal of identifiers from MCP tool results before they reach
   * a model (@renkei/redaction). On by default: the shipped detectors are
   * precise enough to run untuned, and a protection nobody switches on
   * protects nobody.
   */
  redactionEnabled: boolean;
  /**
   * Which detectors run. Patient names and phone numbers are absent from the
   * default on purpose — names because the marker vocabulary varies by org,
   * phone because signature blocks are full of them.
   */
  redactionDetectors: string[];
  /**
   * Extra medical-record-number shapes, in the redaction package's pattern
   * language (`MR-#######`), NOT regular expressions — admin-supplied regex
   * runs in a shared process and can be made to backtrack for minutes. There
   * is no universal MRN format, so a site has to say what its own look like.
   */
  redactionMrnFormats: string[];
}

/** The defaults formerly hardcoded in the environment schema. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  readOnly: false,
  disabledConnectors: [],
  enableDcr: true,
  maxJqlResults: 100,
  maxAttachmentBytes: 20_971_520, // 20MB
  rateLimitPerUserPerMinute: 60,
  accessTokenTtlMinutes: 60,
  authorizationCodeTtlSeconds: 60,
  refreshTokenTtlDays: 30,
  redactionEnabled: true,
  redactionDetectors: ['ssn', 'card', 'mrn', 'dob'],
  redactionMrnFormats: [],
};

const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const orgCache = new Map<string, CacheEntry<OrgSettings>>();

function coerce(current: unknown, fallback: boolean | number): boolean | number {
  if (typeof fallback === 'boolean') return typeof current === 'boolean' ? current : fallback;
  return typeof current === 'number' && Number.isFinite(current) ? current : fallback;
}

/** The first non-scalar setting, so it needs its own guard rather than coerce. */
function coerceStringList(current: unknown, fallback: string[]): string[] {
  if (!Array.isArray(current)) return fallback;
  return current.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * The org's settings, defaults filled in for anything unset. Cached briefly;
 * a change takes effect within the TTL (or immediately after a setter, which
 * invalidates).
 */
export async function getOrgSettings(tenantId: string): Promise<Result<OrgSettings, 'DB_ERROR'>> {
  const cached = orgCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('tenant_settings')
        .select(['key', 'value'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;

  const stored = new Map(rowsResult.val.map((row) => [row.key, row.value]));
  const d = DEFAULT_ORG_SETTINGS;
  const settings: OrgSettings = {
    readOnly: Boolean(coerce(stored.get('read_only'), d.readOnly)),
    disabledConnectors: coerceStringList(stored.get('disabled_connectors'), d.disabledConnectors),
    enableDcr: Boolean(coerce(stored.get('enable_dcr'), d.enableDcr)),
    maxJqlResults: Number(coerce(stored.get('max_jql_results'), d.maxJqlResults)),
    maxAttachmentBytes: Number(coerce(stored.get('max_attachment_bytes'), d.maxAttachmentBytes)),
    rateLimitPerUserPerMinute: Number(
      coerce(stored.get('rate_limit_per_user_per_minute'), d.rateLimitPerUserPerMinute)
    ),
    accessTokenTtlMinutes: Number(
      coerce(stored.get('access_token_ttl_minutes'), d.accessTokenTtlMinutes)
    ),
    authorizationCodeTtlSeconds: Number(
      coerce(stored.get('authorization_code_ttl_seconds'), d.authorizationCodeTtlSeconds)
    ),
    refreshTokenTtlDays: Number(
      coerce(stored.get('refresh_token_ttl_days'), d.refreshTokenTtlDays)
    ),
    redactionEnabled: Boolean(coerce(stored.get('redaction_enabled'), d.redactionEnabled)),
    redactionDetectors: coerceStringList(stored.get('redaction_detectors'), d.redactionDetectors),
    // A new key rather than a reused one: the old `redaction_mrn_patterns`
    // held regular expressions, and silently reinterpreting those as patterns
    // in a different language would change what they match.
    redactionMrnFormats: coerceStringList(
      stored.get('redaction_mrn_formats'),
      d.redactionMrnFormats
    ),
  };

  orgCache.set(tenantId, { value: settings, expiresAt: Date.now() + CACHE_TTL_MS });
  return ok(settings);
}

/** Upsert a subset of org settings; unspecified fields keep their value. */
export async function setOrgSettings(
  tenantId: string,
  updates: Partial<OrgSettings>
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const pairs: Array<[string, boolean | number | string[] | undefined]> = [
    ['read_only', updates.readOnly],
    ['disabled_connectors', updates.disabledConnectors],
    ['enable_dcr', updates.enableDcr],
    ['max_jql_results', updates.maxJqlResults],
    ['max_attachment_bytes', updates.maxAttachmentBytes],
    ['rate_limit_per_user_per_minute', updates.rateLimitPerUserPerMinute],
    ['access_token_ttl_minutes', updates.accessTokenTtlMinutes],
    ['authorization_code_ttl_seconds', updates.authorizationCodeTtlSeconds],
    ['refresh_token_ttl_days', updates.refreshTokenTtlDays],
    ['redaction_enabled', updates.redactionEnabled],
    ['redaction_detectors', updates.redactionDetectors],
    ['redaction_mrn_formats', updates.redactionMrnFormats],
  ];

  for (const [key, value] of pairs) {
    if (value === undefined) continue;
    const result = await wrapAsync(
      () =>
        db
          .insertInto('tenant_settings')
          .values({
            tenant_id: tenantId,
            key,
            value: JSON.stringify(value),
            updated_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'key']).doUpdateSet({
              value: JSON.stringify(value),
              updated_at: new Date().toISOString(),
            })
          )
          .execute(),
      'DB_ERROR' as const
    );
    if (!result.ok) return result;
  }

  orgCache.delete(tenantId);
  return ok();
}

/**
 * The deployment's public base URL from PUBLIC_BASE_URL, or null when unset —
 * web callers then fall back to trusted proxy headers and finally the request
 * URL (see web's getOrigin).
 *
 * Deliberately NOT a platform_settings row, and an exception to Decision #19's
 * policy-is-data rule: this value gates the OIDC redirect_uri, so it must be
 * correct before anyone can authenticate — a setting only reachable behind
 * sign-in cannot configure sign-in. It previously lived in the database, which
 * meant hand-seeding by SQL and silent reversion to localhost whenever the
 * database was rebuilt.
 */
export function getPublicBaseUrl(): string | null {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  return fromEnv ? fromEnv.replace(/\/+$/, '') : null;
}

/** Test hook. */
export function invalidateSettingsCache(): void {
  orgCache.clear();
}
