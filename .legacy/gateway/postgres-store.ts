/**
 * The `GatewayStore` a deployment actually runs on.
 *
 * Two things are load-bearing here rather than in the callers:
 *
 *   - **Encryption.** Atlassian tokens are encrypted on the way in and
 *     decrypted on the way out, using the same AES-256-GCM envelope as the
 *     stdio token file. No caller can write a plaintext token by forgetting to
 *     encrypt, because no caller is given the chance.
 *   - **Atomicity of code redemption.** `redeemAuthorizationCode` is a single
 *     conditional UPDATE. Reading and then writing would leave a window in
 *     which two concurrent redemptions both see an unredeemed code.
 *
 * Timestamps cross this boundary as ISO-8601 strings so the rest of the
 * codebase never has to hold a `Date`, matching the stdio path.
 */

import pg from 'pg';
import type { AuditEvent } from '../audit/logger.js';
import type { Grant } from '../auth/token-store.js';
import { openToken, sealToken } from '../crypto/envelope.js';
import { generateSecret, hashToken } from './tokens.js';
import { KeyRing } from './key-ring.js';
import { PostgresAdminStore } from './postgres-admin-store.js';
import type {
  AuthorizationCode,
  DeviceAuthorizationRecord,
  GatewayStore,
  LinkedSite,
  OAuthClient,
  OnboardingToken,
  PendingAuthorization,
  PendingOrgSignup,
  PlatformAuditEvent,
  Playbook,
  PlaybookInput,
  PlaybookSummary,
  PortalSession,
  Session,
  SessionRotation,
  SessionSummary,
  TenantContext,
} from './store.js';

const { Pool } = pg;

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : new Date(0).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function onboardingToken(row: Row): OnboardingToken {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    allowReplace: row.allow_replace === true,
    expiresAt: iso(row.expires_at),
    attempts: typeof row.attempts === 'number' ? row.attempts : Number(row.attempts ?? 0),
    redeemedAt: isoOrNull(row.redeemed_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function playbookSummary(row: Row): PlaybookSummary {
  return {
    id: text(row.id),
    slug: text(row.slug),
    title: text(row.title),
    enabled: row.enabled === true,
    updatedAt: iso(row.updated_at),
  };
}

function playbook(row: Row): Playbook {
  return { ...playbookSummary(row), bodyMarkdown: text(row.body_markdown) };
}

export interface PostgresStoreOptions {
  connectionString: string;
  /** 32-byte AES key, from `parseEncryptionKey`. */
  encryptionKey: Buffer;
  /** The tenant and site this store acts for, from `bootstrapTenant`. */
  tenant: TenantContext;
  /**
   * The deployment's shared Atlassian app, which a site claim needs and a
   * tenant-bound context is the wrong place to infer. Every tenant claims
   * through this one client — there is no per-tenant override, so this must
   * be supplied at the top level (see `server.ts`) rather than left to a
   * fallback: `tenant.atlassianClientId` is empty on the sentinel tenant
   * every tenant-agnostic route shares.
   */
  sharedAtlassianClientId?: string;
  /**
   * Which key protects each tenant's grants. Shared across the per-request views
   * this class hands out, because a cache with a per-request lifetime is not one.
   */
  keyRing?: KeyRing;
  /** Injected in tests. */
  pool?: pg.Pool;
}

export class PostgresStore implements GatewayStore {
  readonly #pool: pg.Pool;
  readonly #key: Buffer;
  readonly #tenant: TenantContext;
  readonly #sharedAtlassianClientId: string;
  readonly #keyRing: KeyRing;

  constructor(options: PostgresStoreOptions) {
    this.#pool = options.pool ?? new Pool({ connectionString: options.connectionString });
    this.#key = options.encryptionKey;
    this.#tenant = options.tenant;
    this.#sharedAtlassianClientId =
      options.sharedAtlassianClientId ?? options.tenant.atlassianClientId;
    this.#keyRing =
      options.keyRing ??
      new KeyRing({
        pool: this.#pool,
        deploymentKey: options.encryptionKey,
        now: () => Date.now(),
      });
  }

  /**
   * The keys this tenant's grants are sealed under.
   *
   * Read per operation rather than held, so a tenant switching its key takes
   * effect on the next write without anything being restarted — the `KeyRing`'s
   * own cache is what keeps that from being a query per request.
   */
  #keys() {
    return this.#keyRing.keysFor(this.#tenant.tenantId);
  }

  /** Shared with the views handed out by `forTenant`. */
  get keyRing(): KeyRing {
    return this.#keyRing;
  }

  /**
   * The default, and tenant-scoped on purpose.
   *
   * Row-level security decides what these queries can see from
   * `renkei.tenant_id`, which has to be set inside the same transaction as
   * the statement it governs. Making the scoped form the default means that
   * forgetting produces the safe outcome: a new method written without thinking
   * about tenancy is still confined to one tenant. The unscoped form below has
   * a name that has to be typed deliberately.
   *
   * `SET LOCAL` semantics via `set_config(..., true)` — a plain `SET` outlives
   * the transaction and, behind a pool, hands the next checkout this tenant.
   */
  async #query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.#inTenantTransaction(async (client) => {
      const result = await client.query(sql, params);
      return result.rows as Row[];
    });
  }

  async #inTenantTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'renkei.tenant_id',
        this.#tenant.tenantId,
      ]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * For the three tables that are deliberately not tenant-scoped:
   * `oauth_clients`, `pending_authorizations`, and `authorization_codes`.
   *
   * A registered MCP client and an in-flight authorization exist before anyone
   * knows which tenant the request will resolve to, so scoping them would make
   * the flow unable to start. Named so that reaching for it is a statement
   * rather than an oversight.
   */
  /**
   * For an `INSERT ... SELECT` whose join must match.
   *
   * A missing row makes those statements insert nothing and report success,
   * which for a session or a grant means the caller believes it stored a
   * credential that does not exist. Every such statement here appends
   * `RETURNING` and comes through this, so the failure is loud at the point it
   * happens rather than at the next request.
   */
  async #queryExpectingWrite(sql: string, params: unknown[], missing: string): Promise<Row[]> {
    const rows = await this.#query(sql, params);
    if (rows.length === 0) throw new Error(missing);
    return rows;
  }

  async #globalQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await this.#pool.query(sql, params);
    return result.rows as Row[];
  }

  /** Fails fast at boot rather than on the first user's first request. */
  async assertReachable(): Promise<void> {
    await this.#globalQuery('SELECT 1');
  }

  // ------------------------------------------------------ tenant resolution

  /**
   * Turns a `/mcp/<tenantSiteId>` into the tenant it belongs to.
   *
   * Goes through `renkei_resolve_endpoint`, a `SECURITY DEFINER` function,
   * because the application role cannot read `tenant_sites` before it knows
   * which tenant it is acting for — that is the policy working, not a gap.
   * See migration 013 for why the function is narrow enough to be safe.
   *
   * Returns null for an unknown ID *and* for a suspended tenant, so a caller
   * cannot tell the two apart and the endpoint namespace stays unenumerable.
   */
  async resolveEndpoint(tenantSiteId: string): Promise<TenantContext | null> {
    const [row] = await this.#globalQuery('SELECT * FROM renkei_resolve_endpoint($1::uuid)', [
      tenantSiteId,
    ]);

    if (!row || row.active !== true) return null;

    return {
      tenantId: text(row.tenant_id),
      tenantSiteId,
      cloudId: text(row.cloud_id),
      atlassianClientId: text(row.atlassian_client_id),
    };
  }

  /**
   * The same resolution as above, keyed on the site claim instead of the
   * endpoint.
   *
   * Through `renkei_resolve_site_claim`, the second `SECURITY DEFINER`
   * function and the last one this design needs — see migration 014 for why it
   * is narrow enough to be safe and what it does disclose. A portal sign-in
   * cannot be told its site: the user picks one at Atlassian and a cloud ID
   * comes back, so the tenant has to be recovered from the claim.
   */
  async resolveSiteClaim(
    cloudId: string,
    atlassianClientId: string,
  ): Promise<TenantContext | null> {
    const [row] = await this.#globalQuery('SELECT * FROM renkei_resolve_site_claim($1, $2)', [
      cloudId,
      atlassianClientId,
    ]);

    if (!row || row.active !== true) return null;

    return {
      tenantId: text(row.tenant_id),
      tenantSiteId: text(row.tenant_site_id),
      cloudId,
      atlassianClientId,
    };
  }

  /**
   * The tenant behind an `/admin/<slug>`.
   *
   * Through `renkei_resolve_slug`, the third and last `SECURITY DEFINER`
   * function — migration 015 says why operator sign-in needs one that the other
   * two do not cover, and why a UUID in the path would have been worse rather
   * than simpler.
   */
  async resolveSlug(slug: string): Promise<{ tenantId: string } | null> {
    const [row] = await this.#globalQuery('SELECT * FROM renkei_resolve_slug($1)', [slug]);

    if (!row || row.active !== true) return null;
    return { tenantId: text(row.tenant_id) };
  }

  /**
   * Through `renkei_resolve_domain` (migration 028), the fourth `SECURITY
   * DEFINER` function. Unlike `resolveSlug`, a suspended tenant is reported
   * rather than folded into null — see the interface doc.
   */
  async resolveDomain(
    domain: string,
  ): Promise<{ tenantId: string; slug: string; active: boolean } | null> {
    const [row] = await this.#globalQuery('SELECT * FROM renkei_resolve_domain($1)', [domain]);

    if (!row) return null;
    return { tenantId: text(row.tenant_id), slug: text(row.slug), active: row.active === true };
  }

  async claimDomain(domain: string): Promise<boolean> {
    const rows = await this.#query(
      `INSERT INTO tenant_domains (tenant_id, domain) VALUES ($1, $2)
       ON CONFLICT (domain) DO NOTHING
       RETURNING id`,
      [this.#tenant.tenantId, domain],
    );
    return rows.length > 0;
  }

  /**
   * The console's view of a tenant, over this store's pool.
   *
   * A different class rather than a scoped `PostgresStore`, because an operator
   * must never hold an object with `getGrant` on it. See ./admin-store.ts.
   */
  admin(tenantId: string): PostgresAdminStore {
    return new PostgresAdminStore({
      pool: this.#pool,
      encryptionKey: this.#key,
      tenantId,
      sharedAtlassianClientId: this.#sharedAtlassianClientId,
    });
  }

  async putPendingOrgSignup(signup: PendingOrgSignup): Promise<void> {
    await this.#globalQuery(
      `INSERT INTO pending_org_signups
         (state, nonce, code_verifier, slug, org_name, domain, issuer, client_id,
          encrypted_client_secret, role_claim, required_role, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        signup.state,
        signup.nonce,
        signup.codeVerifier,
        signup.slug,
        signup.orgName,
        signup.domain,
        signup.issuer,
        signup.clientId,
        signup.encryptedClientSecret,
        signup.roleClaim,
        signup.requiredRole,
        signup.expiresAt,
      ],
    );
  }

  async takePendingOrgSignup(state: string): Promise<PendingOrgSignup | null> {
    const [row] = await this.#globalQuery(
      'DELETE FROM pending_org_signups WHERE state = $1 RETURNING *',
      [state],
    );
    if (!row) return null;

    return {
      state: text(row.state),
      nonce: text(row.nonce),
      codeVerifier: text(row.code_verifier),
      slug: text(row.slug),
      orgName: text(row.org_name),
      domain: text(row.domain),
      issuer: text(row.issuer),
      clientId: text(row.client_id),
      encryptedClientSecret: text(row.encrypted_client_secret),
      roleClaim: text(row.role_claim),
      requiredRole: textOrNull(row.required_role),
      expiresAt: iso(row.expires_at),
    };
  }

  /**
   * The redemption half of onboarding, on the application role.
   *
   * Unscoped like the registration verification above, and for the same reason: the
   * caller holds a secret and nothing else, so the tenant has to come out of the
   * row before anything can be scoped to it. `renkei_app` has SELECT and UPDATE
   * here and no INSERT — the platform role mints, this one spends.
   */
  async findOnboardingToken(tokenHash: string): Promise<OnboardingToken | null> {
    const [row] = await this.#globalQuery(
      'SELECT * FROM tenant_onboarding_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return row ? onboardingToken(row) : null;
  }

  async recordOnboardingAttempt(tokenHash: string): Promise<void> {
    await this.#globalQuery(
      'UPDATE tenant_onboarding_tokens SET attempts = attempts + 1 WHERE token_hash = $1',
      [tokenHash],
    );
  }

  async redeemOnboardingToken(tokenHash: string, at: string): Promise<OnboardingToken | null> {
    // Every condition that makes a token dead is in the WHERE clause, so two
    // concurrent redemptions cannot both succeed and a check-then-write race is
    // impossible without taking a lock.
    const [row] = await this.#globalQuery(
      `UPDATE tenant_onboarding_tokens
          SET redeemed_at = $2
        WHERE token_hash = $1
          AND redeemed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > $2
        RETURNING *`,
      [tokenHash, at],
    );
    return row ? onboardingToken(row) : null;
  }

  /**
   * A view of this store bound to a different tenant, sharing the pool.
   *
   * Request handling resolves a tenant per request, and a store that carried
   * mutable "current tenant" state would race between concurrent requests in
   * the least visible way possible. A new object per request costs nothing —
   * the pool, the key, and every prepared statement are shared — and makes the
   * binding immutable.
   */
  forTenant(tenant: TenantContext): PostgresStore {
    return new PostgresStore({
      connectionString: '',
      encryptionKey: this.#key,
      tenant,
      // Carried forward rather than re-derived: a view bound to a tenant that
      // brought its own app must still know which app the *deployment* shares.
      sharedAtlassianClientId: this.#sharedAtlassianClientId,
      keyRing: this.#keyRing,
      pool: this.#pool,
    });
  }

  /** The tenant this instance is bound to. */
  get tenant(): TenantContext {
    return this.#tenant;
  }

  // ------------------------------------------------------------- clients

  async createClient(client: OAuthClient): Promise<void> {
    await this.#globalQuery(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, secret_hash, scope, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        client.clientId,
        client.clientName,
        client.redirectUris,
        client.secretHash,
        client.scope,
        client.createdAt,
      ],
    );
  }

  async findClient(clientId: string): Promise<OAuthClient | null> {
    const [row] = await this.#globalQuery('SELECT * FROM oauth_clients WHERE client_id = $1', [
      clientId,
    ]);
    if (!row) return null;

    return {
      clientId: text(row.client_id),
      clientName: text(row.client_name),
      redirectUris: textArray(row.redirect_uris),
      secretHash: textOrNull(row.secret_hash),
      scope: textArray(row.scope),
      createdAt: iso(row.created_at),
    };
  }

  // --------------------------------------------- pending authorizations

  async putPendingAuthorization(pending: PendingAuthorization): Promise<void> {
    // A portal sign-in has no client, nowhere to redirect, and no PKCE
    // challenge to honour; the check constraint on the table requires those
    // three to be null for exactly that kind rather than holding a placeholder.
    const mcp = pending.kind === 'mcp' ? pending : null;

    await this.#globalQuery(
      `INSERT INTO pending_authorizations
         (broker_state, kind, client_id, redirect_uri, client_state, code_challenge, scope,
          resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        pending.brokerState,
        pending.kind,
        mcp?.clientId ?? null,
        mcp?.redirectUri ?? null,
        mcp?.clientState ?? null,
        mcp?.codeChallenge ?? null,
        mcp?.scope ?? [],
        mcp?.resource ?? null,
        pending.expiresAt,
      ],
    );
  }

  async takePendingAuthorization(brokerState: string): Promise<PendingAuthorization | null> {
    // DELETE ... RETURNING is what makes this single-use even under a
    // duplicated callback.
    const [row] = await this.#globalQuery(
      'DELETE FROM pending_authorizations WHERE broker_state = $1 RETURNING *',
      [brokerState],
    );
    if (!row) return null;

    if (text(row.kind) === 'portal') {
      return {
        kind: 'portal',
        brokerState: text(row.broker_state),
        expiresAt: iso(row.expires_at),
      };
    }

    if (text(row.kind) === 'mcp_reauth') {
      return {
        kind: 'mcp_reauth',
        brokerState: text(row.broker_state),
        sessionId: text(row.session_id),
        clientState: textOrNull(row.client_state),
        expiresAt: iso(row.expires_at),
      };
    }

    return {
      kind: 'mcp',
      brokerState: text(row.broker_state),
      clientId: text(row.client_id),
      redirectUri: text(row.redirect_uri),
      clientState: textOrNull(row.client_state),
      codeChallenge: text(row.code_challenge),
      scope: textArray(row.scope),
      resource: textOrNull(row.resource),
      expiresAt: iso(row.expires_at),
    };
  }

  // -------------------------------------------------- authorization codes

  async putAuthorizationCode(code: AuthorizationCode): Promise<void> {
    await this.#globalQuery(
      `INSERT INTO authorization_codes
         (code_hash, client_id, redirect_uri, code_challenge, account_id, scope, resource,
          expires_at, redeemed_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        code.codeHash,
        code.clientId,
        code.redirectUri,
        code.codeChallenge,
        code.accountId,
        code.scope,
        code.resource,
        code.expiresAt,
        code.redeemedSessionId,
      ],
    );
  }

  /**
   * An explicit transaction rather than a single clever statement.
   *
   * The obvious one-liner — UPDATE ... SET redeemed = COALESCE(redeemed, $2)
   * RETURNING the old value via a subquery — looks atomic but is not. Under
   * READ COMMITTED a second concurrent redemption blocks on the row lock, then
   * re-reads the row and correctly declines to overwrite; but its subquery
   * already evaluated against the pre-block snapshot, in which the code was
   * still unredeemed. Both callers would conclude they were first. `SELECT ...
   * FOR UPDATE` inside a transaction serializes the read with the write, which
   * is the property this needs.
   */
  async redeemAuthorizationCode(
    codeHash: string,
    sessionId: string,
  ): Promise<AuthorizationCode | null> {
    // authorization_codes is global rather than tenant-scoped — the code is
    // issued before anyone knows which tenant the session will belong to — so
    // this transaction sets no tenant.
    const client = await this.#pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query(
        'SELECT * FROM authorization_codes WHERE code_hash = $1 FOR UPDATE',
        [codeHash],
      );
      const row = locked.rows[0] as Row | undefined;

      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }

      const previousSessionId = textOrNull(row.redeemed_session_id);

      if (previousSessionId === null) {
        await client.query(
          'UPDATE authorization_codes SET redeemed_session_id = $2::uuid WHERE code_hash = $1',
          [codeHash, sessionId],
        );
      }

      await client.query('COMMIT');

      // The row as it was before this call: a non-null session ID here means
      // the caller is looking at a replay.
      return {
        codeHash: text(row.code_hash),
        clientId: text(row.client_id),
        redirectUri: text(row.redirect_uri),
        codeChallenge: text(row.code_challenge),
        accountId: text(row.account_id),
        scope: textArray(row.scope),
        resource: textOrNull(row.resource),
        expiresAt: iso(row.expires_at),
        redeemedSessionId: previousSessionId,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------- users and grants

  async upsertUser(accountId: string, displayName: string): Promise<void> {
    // `users` is global: one Atlassian identity can belong to several tenants.
    await this.#globalQuery(
      `INSERT INTO users (account_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, last_seen_at = now()`,
      [accountId, displayName],
    );
  }

  /**
   * `tenant_id` is not a parameter. It is selected from the site claim, so it
   * cannot disagree with `(cloud_id, atlassian_client_id)` — and if the claim
   * belongs to another tenant, the row-level security check on the insert
   * refuses it rather than this method having to remember to.
   */
  async putGrant(grant: Grant): Promise<void> {
    const keys = await this.#keys();

    await this.#queryExpectingWrite(
      `INSERT INTO atlassian_grants
         (account_id, atlassian_client_id, cloud_id, tenant_id, site_url,
          encrypted_access_token, encrypted_refresh_token, expires_at, scopes, updated_at)
       SELECT $1, $2, $3, ts.tenant_id, $4, $5, $6, $7, $8, $9
         FROM tenant_sites ts
        WHERE ts.cloud_id = $3 AND ts.atlassian_client_id = $2
       ON CONFLICT (account_id, atlassian_client_id, cloud_id) DO UPDATE SET
         site_url = EXCLUDED.site_url,
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = EXCLUDED.updated_at
       RETURNING account_id`,
      [
        grant.accountId,
        grant.atlassianClientId,
        grant.cloudId,
        grant.siteUrl,
        sealToken(grant.accessToken, keys),
        sealToken(grant.refreshToken, keys),
        grant.expiresAt,
        grant.scopes,
        grant.updatedAt,
      ],
      `no registered site for cloud ${grant.cloudId} under Atlassian client ` +
        `${grant.atlassianClientId} — the grant was not stored`,
    );

    // Display metadata, unknown until someone authorizes: a cloud ID does not
    // reveal the site's URL. Recorded once, then left alone.
    await this.#query(
      `UPDATE tenant_sites SET site_url = $3
        WHERE cloud_id = $1 AND atlassian_client_id = $2 AND site_url IS NULL`,
      [grant.cloudId, grant.atlassianClientId, grant.siteUrl],
    );
  }

  async getGrant(accountId: string): Promise<Grant | null> {
    // Scoped to this deployment's site as well as the account: one person can
    // hold grants for several sites, and returning whichever came first would
    // hand the caller a credential for a site it did not ask about.
    const [row] = await this.#query(
      `SELECT g.*, u.display_name
         FROM atlassian_grants g
         JOIN users u ON u.account_id = g.account_id
        WHERE g.account_id = $1 AND g.atlassian_client_id = $2 AND g.cloud_id = $3`,
      [accountId, this.#tenant.atlassianClientId, this.#tenant.cloudId],
    );
    if (!row) return null;

    const keys = await this.#keys();

    return {
      atlassianClientId: text(row.atlassian_client_id),
      cloudId: text(row.cloud_id),
      siteUrl: text(row.site_url),
      accountId: text(row.account_id),
      displayName: text(row.display_name),
      accessToken: openToken(text(row.encrypted_access_token), keys),
      refreshToken: openToken(text(row.encrypted_refresh_token), keys),
      expiresAt: iso(row.expires_at),
      scopes: textArray(row.scopes),
      updatedAt: iso(row.updated_at),
    };
  }

  async deleteGrant(accountId: string): Promise<void> {
    await this.#query(
      `DELETE FROM atlassian_grants
        WHERE account_id = $1 AND atlassian_client_id = $2 AND cloud_id = $3`,
      [accountId, this.#tenant.atlassianClientId, this.#tenant.cloudId],
    );
  }

  // ------------------------------------------------------------ sessions

  async createSession(session: Session): Promise<void> {
    await this.#queryExpectingWrite(
      `INSERT INTO sessions
         (id, client_id, atlassian_account_id, tenant_id, linked_site_id, scope,
          access_token_hash, refresh_token_hash, access_token_expires_at,
          refresh_token_expires_at, resource, last_active_at, revoked_at)
       SELECT $1, $2, $3, $4, ls.id, $5, $6, $7, $8, $9, $10, $11, $12
         FROM linked_sites ls
        WHERE ls.tenant_site_id = $13 AND ls.account_id = $3
       RETURNING id`,
      [
        session.id,
        session.clientId,
        session.accountId,
        this.#tenant.tenantId,
        session.scope,
        session.accessTokenHash,
        session.refreshTokenHash,
        session.accessTokenExpiresAt,
        session.refreshTokenExpiresAt,
        null,
        session.lastSeenAt,
        session.revokedAt,
        this.#tenant.tenantSiteId,
      ],
      `account ${session.accountId} has not linked this site — the session was not created`,
    );
  }

  /**
   * Records that this account intends to use this deployment's site.
   *
   * Created during the Atlassian callback, before the session that references
   * it. Separate from the grant because they answer different questions: the
   * grant is the credential, this is the intent to use it here — and a user can
   * revoke the link without discarding a credential other sessions share.
   */
  async linkSite(accountId: string): Promise<void> {
    await this.#query(
      `INSERT INTO linked_sites (tenant_site_id, account_id, tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_site_id, account_id) DO NOTHING`,
      [this.#tenant.tenantSiteId, accountId, this.#tenant.tenantId],
    );

    await this.#query(
      `INSERT INTO tenant_users (tenant_id, account_id)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, account_id) DO UPDATE SET last_seen_at = now()`,
      [this.#tenant.tenantId, accountId],
    );
  }

  /**
   * The site URL comes from `tenant_sites` rather than being copied onto the
   * link: it is display metadata Atlassian reports, unknown until somebody
   * authorizes, and one copy of it cannot drift from another.
   */
  async getLinkedSite(accountId: string): Promise<LinkedSite | null> {
    const [row] = await this.#query(
      `SELECT ls.*, ts.site_url
         FROM linked_sites ls
         JOIN tenant_sites ts ON ts.id = ls.tenant_site_id
        WHERE ls.tenant_site_id = $1 AND ls.account_id = $2`,
      [this.#tenant.tenantSiteId, accountId],
    );
    if (!row) return null;

    return {
      id: text(row.id),
      tenantSiteId: text(row.tenant_site_id),
      accountId: text(row.account_id),
      label: textOrNull(row.label),
      siteUrl: textOrNull(row.site_url),
      createdAt: iso(row.created_at),
    };
  }

  async setLinkedSiteLabel(accountId: string, label: string | null): Promise<void> {
    await this.#query(
      `UPDATE linked_sites SET label = $3
        WHERE tenant_site_id = $1 AND account_id = $2`,
      [this.#tenant.tenantSiteId, accountId, label],
    );
  }

  async findSessionById(id: string): Promise<Session | null> {
    const [row] = await this.#query(
      `SELECT s.*, ls.tenant_site_id
         FROM sessions s
         JOIN linked_sites ls ON ls.id = s.linked_site_id
        WHERE s.id = $1`,
      [id],
    );
    if (!row) return null;
    return {
      id: text(row.id),
      clientId: text(row.client_id),
      accountId: text(row.atlassian_account_id),
      tenantSiteId: text(row.tenant_site_id),
      scope: textArray(row.scope),
      accessTokenHash: text(row.access_token_hash),
      refreshTokenHash: text(row.refresh_token_hash),
      accessTokenExpiresAt: iso(row.access_token_expires_at),
      refreshTokenExpiresAt: iso(row.refresh_token_expires_at),
      lastSeenAt: iso(row.last_active_at),
      revokedAt: isoOrNull(row.revoked_at),
    };
  }

  async findSessionByAccessToken(hash: string): Promise<Session | null> {
    return this.#findSession('access_token_hash', hash);
  }

  async findSessionByRefreshToken(hash: string): Promise<Session | null> {
    return this.#findSession('refresh_token_hash', hash);
  }

  async #findSession(
    column: 'access_token_hash' | 'refresh_token_hash',
    hash: string,
  ): Promise<Session | null> {
    // The column name is a literal from this file's own union type, never
    // caller input, so there is nothing to interpolate unsafely.
    // Joined rather than denormalized: the endpoint a session belongs to is a
    // property of its linked site, and a copy on `sessions` could drift from it.
    const [row] = await this.#query(
      `SELECT s.*, ls.tenant_site_id
         FROM sessions s
         JOIN linked_sites ls ON ls.id = s.linked_site_id
        WHERE s.${column} = $1`,
      [hash],
    );
    if (!row) return null;

    return {
      id: text(row.id),
      clientId: text(row.client_id),
      accountId: text(row.atlassian_account_id),
      tenantSiteId: text(row.tenant_site_id),
      scope: textArray(row.scope),
      accessTokenHash: text(row.access_token_hash),
      refreshTokenHash: text(row.refresh_token_hash),
      accessTokenExpiresAt: iso(row.access_token_expires_at),
      refreshTokenExpiresAt: iso(row.refresh_token_expires_at),
      lastSeenAt: iso(row.last_active_at),
      revokedAt: isoOrNull(row.revoked_at),
    };
  }

  async rotateSession(id: string, rotation: SessionRotation): Promise<void> {
    await this.#query(
      `UPDATE sessions
          SET access_token_hash = $2,
              refresh_token_hash = $3,
              access_token_expires_at = $4,
              refresh_token_expires_at = $5,
              last_active_at = $6
        WHERE id = $1`,
      [
        id,
        rotation.accessTokenHash,
        rotation.refreshTokenHash,
        rotation.accessTokenExpiresAt,
        rotation.refreshTokenExpiresAt,
        rotation.at,
      ],
    );
  }

  async touchSession(id: string, at: string): Promise<void> {
    await this.#query('UPDATE sessions SET last_active_at = $2 WHERE id = $1', [id, at]);
  }

  async revokeSession(id: string, at: string): Promise<void> {
    await this.#query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [
      id,
      at,
    ]);
  }

  async revokeSessionsForAccount(accountId: string, at: string): Promise<number> {
    const rows = await this.#query(
      `UPDATE sessions SET revoked_at = $2
        WHERE atlassian_account_id = $1 AND revoked_at IS NULL
      RETURNING id`,
      [accountId, at],
    );
    return rows.length;
  }

  /**
   * `oauth_clients` is joined for the name because that is the only thing on the
   * page a person can recognize a connector by — a client ID means nothing to
   * them. It is the client's own registration text, so the renderer escapes it;
   * with open registration it is attacker-supplied.
   */
  async listSessionsForSite(accountId: string): Promise<SessionSummary[]> {
    const rows = await this.#query(
      `SELECT s.id,
              s.created_at,
              s.last_active_at,
              s.refresh_token_expires_at,
              s.revoked_at,
              COALESCE(c.client_name, s.client_id) AS client_name
         FROM sessions s
         JOIN linked_sites ls ON ls.id = s.linked_site_id
         LEFT JOIN oauth_clients c ON c.client_id = s.client_id
        WHERE ls.tenant_site_id = $1 AND s.atlassian_account_id = $2
        ORDER BY s.created_at DESC`,
      [this.#tenant.tenantSiteId, accountId],
    );

    return rows.map((row) => ({
      id: text(row.id),
      clientName: text(row.client_name),
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_active_at),
      expiresAt: iso(row.refresh_token_expires_at),
      revokedAt: isoOrNull(row.revoked_at),
    }));
  }

  async revokeSessionsForSite(accountId: string, at: string): Promise<number> {
    const rows = await this.#query(
      `UPDATE sessions SET revoked_at = $3
         WHERE atlassian_account_id = $2
           AND revoked_at IS NULL
           AND linked_site_id IN (SELECT id FROM linked_sites WHERE tenant_site_id = $1)
       RETURNING id`,
      [this.#tenant.tenantSiteId, accountId, at],
    );
    return rows.length;
  }

  // ----------------------------------------------------------- reauth state

  async createReauthState(sessionId: string, expiresAt: string): Promise<string> {
    const state = generateSecret('');
    const stateHash = hashToken(state);

    await this.#query(
      `INSERT INTO reauth_states (state_hash, session_id, expires_at, used_at)
       VALUES ($1, $2, $3, NULL)`,
      [stateHash, sessionId, expiresAt],
    );

    return state;
  }

  async consumeReauthState(state: string): Promise<string | null> {
    const stateHash = hashToken(state);
    const at = new Date().toISOString();

    const rows = await this.#query(
      `UPDATE reauth_states
        SET used_at = $2
        WHERE state_hash = $1
          AND used_at IS NULL
          AND expires_at > $3
        RETURNING session_id`,
      [stateHash, at, at],
    );

    const [row] = rows;
    if (!row) return null;
    return row.session_id as string;
  }

  // ----------------------------------------------------------- portal sessions

  async createPortalSession(session: PortalSession): Promise<void> {
    // `tenant_site_id` is checked against this tenant's own site rather than
    // trusted from the argument: the insert's row-level security check would
    // catch a foreign tenant, but not another site inside this one.
    if (session.tenantSiteId !== this.#tenant.tenantSiteId) {
      throw new Error(
        `refusing to create a portal session for site ${session.tenantSiteId} on a store bound ` +
          `to ${this.#tenant.tenantSiteId}`,
      );
    }

    await this.#query(
      `INSERT INTO portal_sessions
         (id, tenant_id, tenant_site_id, account_id, token_hash, csrf_token,
          created_at, last_seen_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        session.id,
        this.#tenant.tenantId,
        session.tenantSiteId,
        session.accountId,
        session.tokenHash,
        session.csrfToken,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.revokedAt,
      ],
    );
  }

  async findPortalSession(tokenHash: string): Promise<PortalSession | null> {
    const [row] = await this.#query('SELECT * FROM portal_sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
    if (!row) return null;

    return {
      id: text(row.id),
      tenantSiteId: text(row.tenant_site_id),
      accountId: text(row.account_id),
      tokenHash: text(row.token_hash),
      csrfToken: text(row.csrf_token),
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_seen_at),
      expiresAt: iso(row.expires_at),
      revokedAt: isoOrNull(row.revoked_at),
    };
  }

  async touchPortalSession(id: string, at: string): Promise<void> {
    await this.#query('UPDATE portal_sessions SET last_seen_at = $2 WHERE id = $1', [id, at]);
  }

  async revokePortalSession(id: string, at: string): Promise<void> {
    await this.#query(
      'UPDATE portal_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, at],
    );
  }

  // --------------------------------------------------------------- audit

  async writeAuditEvent(event: AuditEvent): Promise<void> {
    await this.#query(
      `INSERT INTO audit_log
         (occurred_at, atlassian_account_id, tool, issue_keys, outcome, tenant_id, cloud_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.timestamp,
        event.userAccountId,
        event.tool,
        event.issueKeys,
        event.outcome,
        this.#tenant.tenantId,
        this.#tenant.cloudId,
      ],
    );
  }

  /**
   * The one table the application writes and cannot read.
   *
   * Unscoped on purpose, and not because it is convenient: the events here are
   * the ones with no tenant to scope to. `target_tenant_id` records what the
   * request was aimed at when that much resolved, and carries no foreign key —
   * the point of several of these events is that the target did not exist.
   */
  async writePlatformAuditEvent(event: PlatformAuditEvent): Promise<void> {
    await this.#globalQuery(
      `INSERT INTO platform_audit_log
         (event, outcome, source_ip, user_agent, request_path, target_tenant_id,
          atlassian_account_id)
       VALUES ($1, $2, $3::inet, $4, $5, $6::uuid, $7)`,
      [
        event.event,
        event.outcome,
        event.sourceIp,
        event.userAgent,
        event.requestPath,
        event.targetTenantId,
        event.accountId,
      ],
    );
  }

  // ------------------------------------------------------------ playbooks

  async listPlaybooks(): Promise<PlaybookSummary[]> {
    const rows = await this.#query(
      `SELECT id, slug, title, enabled, updated_at FROM tenant_playbooks
       WHERE tenant_id = $1 ORDER BY title`,
      [this.#tenant.tenantId],
    );
    return rows.map(playbookSummary);
  }

  async getPlaybook(slug: string): Promise<Playbook | null> {
    const [row] = await this.#query(
      `SELECT id, slug, title, body_markdown, enabled, updated_at FROM tenant_playbooks
       WHERE tenant_id = $1 AND slug = $2`,
      [this.#tenant.tenantId, slug],
    );
    return row ? playbook(row) : null;
  }

  async putPlaybook(input: PlaybookInput): Promise<void> {
    await this.#query(
      `INSERT INTO tenant_playbooks (tenant_id, slug, title, body_markdown)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, slug) DO UPDATE SET
         title = EXCLUDED.title, body_markdown = EXCLUDED.body_markdown, updated_at = now()`,
      [this.#tenant.tenantId, input.slug, input.title, input.bodyMarkdown],
    );
  }

  async deletePlaybook(slug: string): Promise<void> {
    await this.#query('DELETE FROM tenant_playbooks WHERE tenant_id = $1 AND slug = $2', [
      this.#tenant.tenantId,
      slug,
    ]);
  }

  async setPlaybookEnabled(slug: string, enabled: boolean): Promise<void> {
    await this.#query(
      'UPDATE tenant_playbooks SET enabled = $3, updated_at = now() WHERE tenant_id = $1 AND slug = $2',
      [this.#tenant.tenantId, slug, enabled],
    );
  }

  // ------------------------------------------------------------ lifecycle

  async purgeExpired(now: string): Promise<void> {
    await this.#globalQuery('DELETE FROM pending_authorizations WHERE expires_at <= $1', [now]);
    await this.#globalQuery('DELETE FROM authorization_codes WHERE expires_at <= $1', [now]);
    await this.#globalQuery('DELETE FROM pending_org_signups WHERE expires_at <= $1', [now]);
    // Sessions are deleted only once the refresh token can no longer be used;
    // an expired *access* token is still refreshable.
    await this.#query('DELETE FROM sessions WHERE refresh_token_expires_at <= $1', [now]);
    await this.#query('DELETE FROM portal_sessions WHERE expires_at <= $1', [now]);
    /**
     * `now` directly, like every other table here.
     *
     * This read `new Date(parseInt(now)).toISOString()`, on the assumption that
     * `now` was epoch milliseconds. It is an ISO-8601 string — `app.ts` calls
     * `purgeExpired(now().toISOString())`, and the four statements above would
     * fail outright on anything else. `parseInt('2026-07-25T…')` is `2026`, so
     * the cutoff computed to `1970-01-01T00:00:02.026Z` and this statement
     * matched nothing, forever: expired device authorizations were never
     * collected, and each one holds the operator's `id_token`.
     */
    await this.#globalQuery('DELETE FROM device_authorizations WHERE expires_at <= $1', [now]);
  }

  async saveDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void> {
    await this.#globalQuery(
      `INSERT INTO device_authorizations (device_code, user_code, tenant_slug, issued_at, expires_at, approved_at, operator_subject, id_token, approval_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (device_code) DO UPDATE SET
         approved_at = EXCLUDED.approved_at,
         operator_subject = EXCLUDED.operator_subject,
         id_token = EXCLUDED.id_token,
         approval_token = EXCLUDED.approval_token`,
      [
        record.deviceCode,
        record.userCode,
        record.tenantSlug,
        new Date(record.issuedAt).toISOString(),
        new Date(record.expiresAt).toISOString(),
        record.approvedAt ? new Date(record.approvedAt).toISOString() : null,
        record.operatorSubject ?? null,
        record.idToken ?? null,
        record.approvalToken ?? null,
      ],
    );
  }

  /**
   * One place that reads a `device_authorizations` row, because the three lookups
   * differ only in their WHERE clause. Timestamps go through `iso()` rather than
   * `as string`: `pg` hands back `Date` objects for `timestamptz`, so the cast
   * described a value that never arrives and worked only because `new Date(Date)`
   * happens to be permitted.
   */
  #deviceAuthorization(rows: Row[]): DeviceAuthorizationRecord | null {
    const row = rows[0];
    if (row === undefined) return null;

    const record: DeviceAuthorizationRecord = {
      deviceCode: text(row.device_code),
      userCode: text(row.user_code),
      tenantSlug: text(row.tenant_slug),
      issuedAt: Date.parse(iso(row.issued_at)),
      expiresAt: Date.parse(iso(row.expires_at)),
    };

    const approvedAt = isoOrNull(row.approved_at);
    if (approvedAt !== null) record.approvedAt = Date.parse(approvedAt);

    const subject = textOrNull(row.operator_subject);
    if (subject !== null) record.operatorSubject = subject;

    const idToken = textOrNull(row.id_token);
    if (idToken !== null) record.idToken = idToken;

    const approvalToken = textOrNull(row.approval_token);
    if (approvalToken !== null) record.approvalToken = approvalToken;

    return record;
  }

  async getDeviceAuthorization(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    return this.#deviceAuthorization(
      await this.#globalQuery('SELECT * FROM device_authorizations WHERE device_code = $1', [
        deviceCode,
      ]),
    );
  }

  async getDeviceAuthorizationByUserCode(
    userCode: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    return this.#deviceAuthorization(
      await this.#globalQuery('SELECT * FROM device_authorizations WHERE user_code = $1', [
        userCode,
      ]),
    );
  }

  async getDeviceAuthorizationByApprovalToken(
    approvalToken: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    return this.#deviceAuthorization(
      await this.#globalQuery('SELECT * FROM device_authorizations WHERE approval_token = $1', [
        approvalToken,
      ]),
    );
  }

  async deleteDeviceAuthorization(deviceCode: string): Promise<void> {
    await this.#globalQuery('DELETE FROM device_authorizations WHERE device_code = $1', [
      deviceCode,
    ]);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
