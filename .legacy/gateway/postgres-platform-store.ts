/**
 * The `PlatformStore` a deployment runs on.
 *
 * **Its own pool, on its own role.** `PLATFORM_DATABASE_URL` should name a login
 * role granted `renkei_platform` and nothing else. That role can enumerate
 * `tenants`, which the request path deliberately cannot, and is refused every table
 * holding tenant data — including, by a column-level grant, the one column of
 * `tenant_oidc` that holds a tenant's IdP credential. Migration 019 has the matrix
 * and the reasoning.
 *
 * **`#query` sets no `renkei.tenant_id`, and that is deliberate rather than
 * forgotten.** Every other store here opens a transaction and applies the setting,
 * because row-level security is what confines them; this role's policies are
 * role-scoped (`tenants_platform`, `tenant_oidc_platform`) and match on the role
 * instead. Setting a tenant here would confine the console to one tenant, which is
 * the opposite of its purpose. Stated explicitly because an absent `SET LOCAL` is
 * exactly the bug migration 013 warns about, and a reader is right to check.
 *
 * There is deliberately no method here that returns a grant, a ciphertext, or a
 * tenant's IdP secret — see ./platform-store.ts. Unlike `AdminStore`, that promise
 * is also backed by the grants, so a method added in defiance of it gets a
 * permission error rather than rows.
 */

import pg from 'pg';
import type {
  NewNotification,
  NewOnboardingToken,
  NotificationRecord,
  OnboardingTokenSummary,
  PlatformAuthorization,
  PlatformSession,
  PlatformStore,
  PlatformTenant,
  TenantOidcMetadata,
} from './platform-store.js';

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

function count(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tenant(row: Row): PlatformTenant {
  return {
    id: text(row.id),
    slug: text(row.slug),
    name: text(row.name),
    status: text(row.status) === 'suspended' ? 'suspended' : 'active',
    createdAt: iso(row.created_at),
    hasOidc: row.has_oidc === true,
    pendingOnboardingTokens: count(row.pending_tokens),
  };
}

function onboardingToken(row: Row): OnboardingTokenSummary {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    allowReplace: row.allow_replace === true,
    issuedBySubject: text(row.issued_by_subject),
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    attempts: count(row.attempts),
    redeemedAt: isoOrNull(row.redeemed_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

function notification(row: Row): NotificationRecord {
  return {
    id: text(row.id),
    channel: 'console',
    recipient: text(row.recipient),
    subject: text(row.subject),
    body: text(row.body),
    tenantId: textOrNull(row.tenant_id),
    createdAt: iso(row.created_at),
    deliveredAt: isoOrNull(row.delivered_at),
    failedAt: isoOrNull(row.failed_at),
    failureReason: textOrNull(row.failure_reason),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
  };
}

/**
 * `hasOidc` and the pending-link count, as a subquery each.
 *
 * `hasOidc` is an EXISTS rather than a join, which is what keeps it a boolean
 * reachable under the column-level grant: the console may learn *that* a tenant has
 * an IdP without selecting the row.
 */
const TENANT_COLUMNS = `
  t.id, t.slug, t.name, t.status, t.created_at,
  EXISTS (SELECT 1 FROM tenant_oidc o WHERE o.tenant_id = t.id) AS has_oidc,
  (SELECT count(*) FROM tenant_onboarding_tokens k
    WHERE k.tenant_id = t.id AND k.redeemed_at IS NULL AND k.revoked_at IS NULL
      AND k.expires_at > now()) AS pending_tokens
`;

export interface PostgresPlatformStoreOptions {
  connectionString: string;
  /** Injected in tests. */
  pool?: pg.Pool;
}

export class PostgresPlatformStore implements PlatformStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresPlatformStoreOptions) {
    this.#pool = options.pool ?? new Pool({ connectionString: options.connectionString });
    this.#ownsPool = options.pool === undefined;
  }

  /** No transaction and no tenant setting — see the file comment. */
  async #query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await this.#pool.query(sql, params);
    return result.rows as Row[];
  }

  /**
   * Reachability *and* privilege in one statement.
   *
   * A plain `SELECT 1` would pass on a connection whose role is missing every grant
   * this store needs, and the failure would surface later as a permission error in
   * the middle of a console page. Reading `tenants` proves the role can do the one
   * thing it exists for.
   */
  async assertReachable(): Promise<void> {
    await this.#query('SELECT count(*) FROM tenants');
  }

  // ------------------------------------------------------------------ tenants

  async listTenants(): Promise<PlatformTenant[]> {
    const rows = await this.#query(`SELECT ${TENANT_COLUMNS} FROM tenants t ORDER BY t.slug`);
    return rows.map(tenant);
  }

  async findTenantBySlug(slug: string): Promise<PlatformTenant | null> {
    const [row] = await this.#query(`SELECT ${TENANT_COLUMNS} FROM tenants t WHERE t.slug = $1`, [
      slug,
    ]);
    return row ? tenant(row) : null;
  }

  async createTenant(slug: string, name: string): Promise<PlatformTenant | null> {
    // ON CONFLICT DO NOTHING rather than an upsert: quietly renaming an existing
    // tenant is worse than reporting that the slug is taken. The re-read is because
    // RETURNING cannot carry the two computed columns.
    const [created] = await this.#query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [slug, name],
    );

    if (created === undefined) return null;
    return this.findTenantBySlug(slug);
  }

  async setTenantStatus(slug: string, status: 'active' | 'suspended'): Promise<boolean> {
    const result = await this.#pool.query('UPDATE tenants SET status = $2 WHERE slug = $1', [
      slug,
      status,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async getTenantOidcMetadata(tenantId: string): Promise<TenantOidcMetadata | null> {
    // The column list is the whole point: `encrypted_client_secret` is absent here
    // and absent from the grant, so this cannot become a way to read it.
    const [row] = await this.#query(
      `SELECT issuer, client_id, role_claim, required_role, updated_at
         FROM tenant_oidc WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!row) return null;

    return {
      issuer: text(row.issuer),
      clientId: text(row.client_id),
      roleClaim: text(row.role_claim),
      requiredRole: textOrNull(row.required_role),
      updatedAt: iso(row.updated_at),
    };
  }

  // -------------------------------------------------------- onboarding links

  async createOnboardingToken(token: NewOnboardingToken): Promise<OnboardingTokenSummary> {
    const [row] = await this.#query(
      `INSERT INTO tenant_onboarding_tokens
         (tenant_id, token_hash, allow_replace, issued_by_subject, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [token.tenantId, token.tokenHash, token.allowReplace, token.issuedBySubject, token.expiresAt],
    );

    if (!row) throw new Error('could not create an onboarding token');
    return onboardingToken(row);
  }

  async listOnboardingTokens(tenantId: string): Promise<OnboardingTokenSummary[]> {
    const rows = await this.#query(
      `SELECT * FROM tenant_onboarding_tokens WHERE tenant_id = $1 ORDER BY issued_at DESC`,
      [tenantId],
    );
    return rows.map(onboardingToken);
  }

  async revokeOnboardingToken(id: string, at: string): Promise<boolean> {
    // A redeemed token is not revocable: there is nothing left to withdraw, and
    // saying so beats reporting success for a no-op.
    const result = await this.#pool.query(
      `UPDATE tenant_onboarding_tokens SET revoked_at = $2
        WHERE id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [id, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------- the console

  async putPlatformAuthorization(pending: PlatformAuthorization): Promise<void> {
    await this.#query(
      `INSERT INTO platform_authorizations (state, nonce, code_verifier, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [pending.state, pending.nonce, pending.codeVerifier, pending.expiresAt],
    );
  }

  async takePlatformAuthorization(state: string): Promise<PlatformAuthorization | null> {
    // DELETE ... RETURNING is what makes this single-use even under a duplicated
    // callback, the same property the operator path's equivalent relies on.
    const [row] = await this.#query(
      'DELETE FROM platform_authorizations WHERE state = $1 RETURNING *',
      [state],
    );
    if (!row) return null;

    return {
      state: text(row.state),
      nonce: text(row.nonce),
      codeVerifier: text(row.code_verifier),
      expiresAt: iso(row.expires_at),
    };
  }

  async createPlatformSession(session: PlatformSession): Promise<void> {
    await this.#query(
      `INSERT INTO platform_sessions
         (id, subject, display_name, token_hash, csrf_token, created_at, last_seen_at,
          expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        session.id,
        session.subject,
        session.displayName,
        session.tokenHash,
        session.csrfToken,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.revokedAt,
      ],
    );
  }

  async findPlatformSession(tokenHash: string): Promise<PlatformSession | null> {
    const [row] = await this.#query('SELECT * FROM platform_sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
    if (!row) return null;

    return {
      id: text(row.id),
      subject: text(row.subject),
      displayName: textOrNull(row.display_name),
      tokenHash: text(row.token_hash),
      csrfToken: text(row.csrf_token),
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_seen_at),
      expiresAt: iso(row.expires_at),
      revokedAt: isoOrNull(row.revoked_at),
    };
  }

  async touchPlatformSession(id: string, at: string): Promise<void> {
    await this.#query('UPDATE platform_sessions SET last_seen_at = $2 WHERE id = $1', [id, at]);
  }

  async revokePlatformSession(id: string, at: string): Promise<void> {
    await this.#query(
      'UPDATE platform_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, at],
    );
  }

  // ------------------------------------------------------------ notifications

  async createNotification(input: NewNotification): Promise<NotificationRecord> {
    const [row] = await this.#query(
      `INSERT INTO notifications
         (channel, recipient, subject, body, tenant_id, delivered_at, failed_at, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.channel,
        input.recipient,
        input.subject,
        input.body,
        input.tenantId,
        input.deliveredAt,
        input.failedAt,
        input.failureReason,
      ],
    );

    if (!row) throw new Error('could not record a notification');
    return notification(row);
  }

  async listNotifications(limit: number): Promise<NotificationRecord[]> {
    const rows = await this.#query(
      'SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT $1',
      [limit],
    );
    return rows.map(notification);
  }

  async acknowledgeNotification(id: string, at: string): Promise<void> {
    await this.#query(
      'UPDATE notifications SET acknowledged_at = $2 WHERE id = $1 AND acknowledged_at IS NULL',
      [id, at],
    );
  }

  /**
   * Expired sign-in state, and notification bodies that have outlived their token.
   *
   * The second half is the one worth stating: a `console` notification's body holds
   * the onboarding URL, so leaving it after the token is dead would keep a useless
   * secret at rest forever. Deleting the row rather than blanking the body keeps the
   * table's meaning simple — what is here was deliverable.
   */
  async purgeExpired(now: string): Promise<void> {
    await this.#query('DELETE FROM platform_authorizations WHERE expires_at <= $1', [now]);
    await this.#query(
      `DELETE FROM notifications
        WHERE id IN (
          SELECT n.id FROM notifications n
           WHERE NOT EXISTS (
             SELECT 1 FROM tenant_onboarding_tokens k
              WHERE k.tenant_id = n.tenant_id
                AND k.expires_at > $1
                AND k.redeemed_at IS NULL
                AND k.revoked_at IS NULL
           )
             AND n.created_at <= $1::timestamptz - interval '24 hours'
        )`,
      [now],
    );
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}
