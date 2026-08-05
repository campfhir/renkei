import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * Two deployment shapes read from the same environment:
 *
 *   - stdio  — one operator, one grant, tokens in an encrypted file. No HTTP
 *              surface, so no public base URL and no Postgres.
 *   - server — the multi-user gateway. Everything below plus the HTTP and
 *              database settings.
 *
 * `baseEnvSchema` is the intersection. Keeping them separate means the stdio
 * entrypoint cannot start half-configured, and the server entrypoint cannot
 * start missing its database.
 */

const encryptionKeySchema = z
  .string()
  .refine((value) => Buffer.from(value, 'base64').byteLength === 32, {
    message: 'TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)',
  });

const baseEnvSchema = z.object({
  ATLASSIAN_CLIENT_ID: z.string().min(1),
  ATLASSIAN_CLIENT_SECRET: z.string().min(1),
  ATLASSIAN_REDIRECT_URI: z.string().url(),
  ATLASSIAN_SCOPES: z.string().min(1),
  // Required for stdio (checked in loadBaseConfig, not here) but not for the
  // gateway: every gateway code path that touches a cloud ID overrides this
  // with the resolved tenant's own site before use, so requiring it here
  // would refuse to boot a deployment that will never read it.
  ATLASSIAN_CLOUD_ID: z.string().min(1).optional(),

  TOKEN_ENCRYPTION_KEY: encryptionKeySchema,
  TOKEN_STORE_PATH: z.string().min(1).optional(),

  MAX_JQL_RESULTS: z.coerce.number().int().positive().max(1000).default(100),
  RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().int().positive().default(60),

  // Attachment bytes arrive base64-encoded inside the JSON-RPC message, which
  // inflates them by a third and holds the whole thing in memory. The ceiling
  // is a third of Jira Cloud's own 10 MB default rather than matching it: a
  // file that large does not belong in a tool call, and refusing it here is a
  // clearer failure than a truncated upload or an out-of-memory server.
  MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(3 * 1024 * 1024),

  // A deployment-level kill switch for every mutating tool. Enforced by not
  // registering them, so they are absent from tools/list rather than present
  // and failing — a model cannot be talked into calling a tool it cannot see.
  // Only the literal string 'true' enables it; anything else is off, so a typo
  // fails toward the configured-and-explicit default rather than silently
  // disabling writes.
  READ_ONLY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const serverEnvSchema = baseEnvSchema
  .extend({
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    PUBLIC_BASE_URL: z.string().url(),

    /**
     * The request path's connection, and the one a deployment is expected to
     * set. It should name a login role granted `renkei_app` and nothing
     * else, so that row-level security actually applies to it.
     */
    DATABASE_URL: z.string().min(1),
    /**
     * Not read by the running gateway process at all — only compared against
     * DATABASE_URL to decide whether to warn at boot. The value that matters is
     * read directly from the environment by `pnpm migrate` and `pnpm tenant`,
     * both of which need privileges the request path must not have. Falls back
     * to DATABASE_URL here, which still runs but is a weaker deployment: RLS
     * does not apply to a superuser or to the owner of the tables, so one
     * shared identity leaves every policy present and inert. The server warns
     * rather than refusing — a single-tenant deployment is not much worse off,
     * and refusing would make the simplest setup the hardest.
     */
    MIGRATION_DATABASE_URL: z.string().min(1).optional(),

    SESSION_INACTIVITY_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(60),

    // Short, because refreshing is cheap and a leaked access token is only
    // useful until it expires.
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
    // The outer bound on a session. Inactivity usually ends one first.
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
    // Long enough for a browser redirect, short enough that a code sitting in
    // a proxy log is worthless by the time anyone reads it.
    AUTHORIZATION_CODE_TTL_SECONDS: z.coerce.number().int().positive().max(600).default(60),

    // Dynamic Client Registration. On by default because it is what lets a
    // hosted client such as Claude.ai self-register, which is the documented
    // onboarding path. Turning it off means every client is added by hand —
    // the right choice for a closed or regulated deployment. See README Open
    // Question #5.
    ENABLE_DCR: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /**
     * The **platform operator's** identity provider: one for the whole
     * deployment, from the environment rather than a table.
     *
     * A tenant's IdP lives in `tenant_oidc` because there is one per tenant and a
     * tenant configures its own. There is exactly one of these, and the surface
     * that would configure it is the console it gates — which is the bootstrap
     * this exists to break, so it cannot come from the database.
     *
     * Optional. Absent means no `/platform` console and no onboarding links: a
     * single-organization deployment creates its one tenant through the `/`
     * wizard or `pnpm tenant create` and never needs either.
     *
     * Its redirect URI is fixed at `<PUBLIC_BASE_URL>/platform/callback` rather
     * than configured — one path registered once serves every environment.
     */
    PLATFORM_OIDC_ISSUER: z.string().min(1).optional(),
    PLATFORM_OIDC_CLIENT_ID: z.string().min(1).optional(),
    PLATFORM_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    PLATFORM_OIDC_ROLE_CLAIM: z.string().min(1).default('roles'),
    PLATFORM_OIDC_REQUIRED_ROLE: z.string().min(1).optional(),

    /**
     * The platform console's connection: a login role granted `renkei_platform`
     * and nothing else, created by migration 019.
     *
     * That role can enumerate tenants — which the request path deliberately
     * cannot — and is refused every table holding tenant data, including the
     * column holding a tenant's own IdP secret. Falling back to the migration
     * identity works and gives up that guarantee, so the server warns.
     */
    PLATFORM_DATABASE_URL: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // Atlassian redirects the browser to ATLASSIAN_REDIRECT_URI, and only
    // /oauth/callback knows what to do with it. A mismatch here produces a
    // sign-in that completes at Atlassian and then 404s, which is a miserable
    // thing to debug at runtime — so it fails at boot instead.
    const expected = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/oauth/callback`;

    if (env.ATLASSIAN_REDIRECT_URI !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ATLASSIAN_REDIRECT_URI'],
        message:
          `must be ${expected} for the gateway (derived from PUBLIC_BASE_URL), and must match ` +
          'the callback URL registered on the Atlassian app exactly',
      });
    }

    const platformParts = [
      env.PLATFORM_OIDC_ISSUER,
      env.PLATFORM_OIDC_CLIENT_ID,
      env.PLATFORM_OIDC_CLIENT_SECRET,
    ];
    const platformConfigured = platformParts.some((part) => part !== undefined);

    // A partly-configured console would offer a sign-in and fail somewhere in
    // the middle of it.
    if (platformConfigured && platformParts.some((part) => part === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PLATFORM_OIDC_CLIENT_SECRET'],
        message:
          'PLATFORM_OIDC_ISSUER, PLATFORM_OIDC_CLIENT_ID and PLATFORM_OIDC_CLIENT_SECRET must ' +
          'be set together, or none of them',
      });
    }

    if (platformConfigured && env.PLATFORM_OIDC_ISSUER !== undefined) {
      // The rule `OidcClient.assertUsableIssuer` enforces at sign-in, checked here
      // so a deployment-wide typo fails at boot rather than at the platform
      // operator's first attempt to use the console.
      let issuer: URL | null;
      try {
        issuer = new URL(env.PLATFORM_OIDC_ISSUER);
      } catch {
        issuer = null;
      }

      const loopback =
        issuer !== null && (issuer.hostname === 'localhost' || issuer.hostname === '127.0.0.1');

      if (issuer === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLATFORM_OIDC_ISSUER'],
          message: 'must be a URL',
        });
      } else if (issuer.protocol !== 'https:' && !loopback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLATFORM_OIDC_ISSUER'],
          message: 'must be https (sign-in over plain HTTP can be rewritten in transit)',
        });
      }
    }

    /**
     * Required for the platform IdP, unlike a tenant's, where it is nullable and
     * the CLI merely warns.
     *
     * The asymmetry is blast radius rather than inconsistency. For a tenant,
     * omitting it means "any subject this IdP authenticates operates this tenant",
     * the organization restricts its own IdP application, and the consequence lands
     * on the organization that chose it. Here, omitting it means every subject a
     * possibly-shared corporate directory knows can create tenants and mint an
     * onboarding link for any existing one — and whoever runs the deployment often
     * does not control that directory's assignment list. Granting deployment-wide
     * authority must not be reachable by leaving a variable unset.
     */
    if (platformConfigured && env.PLATFORM_OIDC_REQUIRED_ROLE === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PLATFORM_OIDC_REQUIRED_ROLE'],
        message:
          'is required when a platform IdP is configured: without it, every subject the provider ' +
          'authenticates could create tenants and issue onboarding links for any of them',
      });
    }
  });

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface AtlassianConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  cloudId: string;
}

/** Settings both entrypoints need. */
export interface BaseConfig {
  atlassian: AtlassianConfig;
  tokenEncryptionKey: string;
  tokenStorePath: string;
  maxJqlResults: number;
  rateLimitPerUserPerMinute: number;
  /** Largest decoded attachment an upload tool will accept. */
  maxAttachmentBytes: number;
  /** When true, no mutating tool is registered. */
  readOnly: boolean;
  logLevel: LogLevel;
}

export type Config = BaseConfig & {
  port: number;
  host: string;
  publicBaseUrl: string;
  /** The request path. Restricted, so row-level security actually applies. */
  databaseUrl: string;
  /** Migrations and boot-time tenant resolution. Privileged. */
  migrationDatabaseUrl: string;
  /**
   * True when both point at the same identity, however that came about —
   * whether MIGRATION_DATABASE_URL is unset or set to the same value. Either
   * way the policies are inert, so the check is on the outcome rather than on
   * which variable was provided.
   */
  sharesMigrationIdentity: boolean;
  sessionInactivityTimeoutMinutes: number;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  authorizationCodeTtlSeconds: number;
  enableDcr: boolean;
  /**
   * The platform operator's IdP, or null when the deployment has no `/platform`
   * console. Null means the routes are never registered at all, so the surface
   * does not exist rather than existing and refusing.
   */
  platformOidc: PlatformOidcConfig | null;
  /** The platform console's connection. Enumerates tenants; reads no tenant data. */
  platformDatabaseUrl: string;
  /**
   * True when the platform console shares an identity with migrations, however
   * that came about. The narrow role is the control; a shared one still works and
   * gives up the guarantee that the console cannot read tenant data, so the server
   * warns rather than refusing.
   */
  sharesPlatformIdentity: boolean;
};

/**
 * Structurally assignable to `gateway/oidc.ts`'s `OidcConfig`, so it passes
 * straight to `discover`/`buildAuthorizeUrl`/`exchangeCode`/`verifyIdToken`.
 * Restated rather than imported because `config.ts` imports nothing from
 * `gateway/`, and inverting that for one type would cost more than five fields.
 *
 * `requiredRole` is `string` rather than `string | null`, which is how "mandatory
 * for this role" becomes a fact the compiler knows.
 */
export interface PlatformOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim: string;
  requiredRole: string;
  redirectUri: string;
}

export function defaultTokenStorePath(): string {
  return join(homedir(), '.renkei', 'tokens.json');
}

type BaseEnv = z.infer<typeof baseEnvSchema>;

function toBaseConfig(parsed: BaseEnv): BaseConfig {
  return {
    atlassian: {
      clientId: parsed.ATLASSIAN_CLIENT_ID,
      clientSecret: parsed.ATLASSIAN_CLIENT_SECRET,
      redirectUri: parsed.ATLASSIAN_REDIRECT_URI,
      scopes: parsed.ATLASSIAN_SCOPES.split(/\s+/).filter(Boolean),
      // Empty when unset, which only the gateway ever does — loadBaseConfig
      // below refuses to reach here without one, and every gateway code path
      // that needs a cloud ID overrides this rather than reading it.
      cloudId: parsed.ATLASSIAN_CLOUD_ID ?? '',
    },
    tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
    tokenStorePath: parsed.TOKEN_STORE_PATH ?? defaultTokenStorePath(),
    maxJqlResults: parsed.MAX_JQL_RESULTS,
    rateLimitPerUserPerMinute: parsed.RATE_LIMIT_PER_USER_PER_MINUTE,
    maxAttachmentBytes: parsed.MAX_ATTACHMENT_BYTES,
    readOnly: parsed.READ_ONLY,
    logLevel: parsed.LOG_LEVEL,
  };
}

/** Config for the stdio MCP entrypoint and the `auth` CLI. No HTTP, no database. */
export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): Result<BaseConfig, 'CONFIG_ERROR'> {
  const parsed = baseEnvSchema.safeParse(env);

  if (!parsed.success) {
    return err('CONFIG_ERROR' as const, {
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }

  // Optional in the shared schema because the gateway never reads it, but
  // stdio pins the stored grant's site against it — see toBaseConfig.
  if (parsed.data.ATLASSIAN_CLOUD_ID === undefined) {
    return err('CONFIG_ERROR' as const, {
      message: 'Required for the stdio entrypoint: ATLASSIAN_CLOUD_ID. Find it at https://<site>.atlassian.net/_edge/tenant_info',
    });
  }

  return ok(toBaseConfig(parsed.data));
}

/** Config for the HTTP gateway. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<Config, 'CONFIG_ERROR'> {
  const parsed = serverEnvSchema.safeParse(env);

  if (!parsed.success) {
    return err('CONFIG_ERROR' as const, {
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }

  const data = parsed.data;
  return ok({
    ...toBaseConfig(data),
    port: data.PORT,
    host: data.HOST,
    publicBaseUrl: data.PUBLIC_BASE_URL,
    databaseUrl: data.DATABASE_URL,
    migrationDatabaseUrl: data.MIGRATION_DATABASE_URL ?? data.DATABASE_URL,
    sharesMigrationIdentity:
      data.MIGRATION_DATABASE_URL === undefined ||
      data.MIGRATION_DATABASE_URL === data.DATABASE_URL,
    sessionInactivityTimeoutMinutes: data.SESSION_INACTIVITY_TIMEOUT_MINUTES,
    accessTokenTtlMinutes: data.ACCESS_TOKEN_TTL_MINUTES,
    refreshTokenTtlDays: data.REFRESH_TOKEN_TTL_DAYS,
    authorizationCodeTtlSeconds: data.AUTHORIZATION_CODE_TTL_SECONDS,
    enableDcr: data.ENABLE_DCR,
    platformOidc:
      data.PLATFORM_OIDC_ISSUER === undefined ||
      data.PLATFORM_OIDC_CLIENT_ID === undefined ||
      data.PLATFORM_OIDC_CLIENT_SECRET === undefined ||
      data.PLATFORM_OIDC_REQUIRED_ROLE === undefined
        ? null
        : {
            // Verbatim, whitespace aside. OIDC Discovery §4.3 compares this for
            // exact equality against the `issuer` in the provider's own document,
            // and Auth0 and Entra both describe themselves with a trailing slash —
            // so normalizing one away is the single edit that guarantees no
            // sign-in can ever succeed.
            issuer: data.PLATFORM_OIDC_ISSUER.trim(),
            clientId: data.PLATFORM_OIDC_CLIENT_ID,
            clientSecret: data.PLATFORM_OIDC_CLIENT_SECRET,
            roleClaim: data.PLATFORM_OIDC_ROLE_CLAIM,
            requiredRole: data.PLATFORM_OIDC_REQUIRED_ROLE,
            redirectUri: `${data.PUBLIC_BASE_URL.replace(/\/+$/, '')}/platform/callback`,
          },
    platformDatabaseUrl:
      data.PLATFORM_DATABASE_URL ?? data.MIGRATION_DATABASE_URL ?? data.DATABASE_URL,
    sharesPlatformIdentity:
      data.PLATFORM_DATABASE_URL === undefined ||
      data.PLATFORM_DATABASE_URL === (data.MIGRATION_DATABASE_URL ?? data.DATABASE_URL) ||
      data.PLATFORM_DATABASE_URL === data.DATABASE_URL,
  });
}

/**
 * Config for the platform operator's CLI.
 *
 * Deliberately much smaller than the gateway's. Creating a tenant and handing it
 * to its operator needs a privileged database connection and the deployment key
 * that protects `tenant_oidc`, and nothing else — no Atlassian app, no public
 * base URL. Requiring the full server environment would have implied the
 * platform operator needs the delegation path's credentials, which is exactly the
 * thing this role is defined not to have.
 */
export interface PlatformConfig {
  databaseUrl: string;
  tokenEncryptionKey: string;
}

const platformEnvSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: encryptionKeySchema,
});

export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): Result<PlatformConfig, 'CONFIG_ERROR'> {
  const parsed = platformEnvSchema.safeParse(env);

  if (!parsed.success) {
    return err('CONFIG_ERROR' as const, {
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }

  // The privileged identity by preference: creating a tenant writes rows the
  // request path's role cannot see, which is the policy working.
  const databaseUrl = parsed.data.MIGRATION_DATABASE_URL ?? parsed.data.DATABASE_URL;

  if (databaseUrl === undefined) {
    return err('CONFIG_ERROR' as const, {
      message: 'set MIGRATION_DATABASE_URL (preferred) or DATABASE_URL',
    });
  }

  return ok({ databaseUrl, tokenEncryptionKey: parsed.data.TOKEN_ENCRYPTION_KEY });
}
