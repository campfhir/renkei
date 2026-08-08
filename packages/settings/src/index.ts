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
  /** RFC 7591 dynamic client registration on this org's OAuth server. */
  enableDcr: boolean;
  maxJqlResults: number;
  maxAttachmentBytes: number;
  rateLimitPerUserPerMinute: number;
  accessTokenTtlMinutes: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlDays: number;
}

/** The defaults formerly hardcoded in the environment schema. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  readOnly: false,
  enableDcr: true,
  maxJqlResults: 100,
  maxAttachmentBytes: 20_971_520, // 20MB
  rateLimitPerUserPerMinute: 60,
  accessTokenTtlMinutes: 60,
  authorizationCodeTtlSeconds: 60,
  refreshTokenTtlDays: 30,
};

const PUBLIC_BASE_URL_KEY = 'public_base_url';

const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const orgCache = new Map<string, CacheEntry<OrgSettings>>();
let platformBaseUrlCache: CacheEntry<string | null> | null = null;

function coerce(current: unknown, fallback: boolean | number): boolean | number {
  if (typeof fallback === 'boolean') return typeof current === 'boolean' ? current : fallback;
  return typeof current === 'number' && Number.isFinite(current) ? current : fallback;
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

  const pairs: Array<[string, boolean | number | undefined]> = [
    ['read_only', updates.readOnly],
    ['enable_dcr', updates.enableDcr],
    ['max_jql_results', updates.maxJqlResults],
    ['max_attachment_bytes', updates.maxAttachmentBytes],
    ['rate_limit_per_user_per_minute', updates.rateLimitPerUserPerMinute],
    ['access_token_ttl_minutes', updates.accessTokenTtlMinutes],
    ['authorization_code_ttl_seconds', updates.authorizationCodeTtlSeconds],
    ['refresh_token_ttl_days', updates.refreshTokenTtlDays],
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
 * The deployment's public base URL, or null when unset — callers fall back
 * to trusted request headers (see web's getOrigin), which is also what makes
 * first-boot configuration reachable before this value exists.
 *
 * PUBLIC_BASE_URL from the environment wins over the platform_settings row.
 * The deploy compose file has always shipped that variable in .env, but
 * nothing read it — the row was the only source, and it had to be seeded by
 * hand. A rebuilt database then silently reverted every OIDC redirect_uri to
 * the localhost fallback. Deployment shape belongs to the deployment.
 */
export async function getPublicBaseUrl(): Promise<Result<string | null, 'DB_ERROR'>> {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  if (fromEnv) {
    return ok(fromEnv.replace(/\/+$/, ''));
  }

  if (platformBaseUrlCache && platformBaseUrlCache.expiresAt > Date.now()) {
    return ok(platformBaseUrlCache.value);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('platform_settings')
        .select('value')
        .where('key', '=', PUBLIC_BASE_URL_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;

  const value = typeof rowResult.val?.value === 'string' ? rowResult.val.value : null;
  platformBaseUrlCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return ok(value);
}

export async function setPublicBaseUrl(url: string): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('platform_settings')
        .values({
          key: PUBLIC_BASE_URL_KEY,
          value: JSON.stringify(url),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({
            value: JSON.stringify(url),
            updated_at: new Date().toISOString(),
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;

  platformBaseUrlCache = null;
  return ok();
}

/** Test hook. */
export function invalidateSettingsCache(): void {
  orgCache.clear();
  platformBaseUrlCache = null;
}
