/**
 * The `AdminStore` a deployment runs on.
 *
 * Shares `PostgresStore`'s pool and its transaction discipline — every statement
 * runs inside a transaction that has already applied `SET LOCAL
 * renkei.tenant_id`, so row-level security confines a query that forgot its
 * predicate to nothing rather than to somebody else's rows.
 *
 * What it does *not* share is the encryption key's use on grants. This class
 * holds the deployment key because `tenant_oidc.encrypted_client_secret` needs
 * it, and there is deliberately no method here that decrypts `atlassian_grants`
 * — see ./admin-store.ts for why that is the point.
 */

import type pg from 'pg';
import { decrypt, encrypt } from '../crypto/secretbox.js';
import type {
  AdminAuditRow,
  AdminPlaybook,
  AdminPlaybookInput,
  AdminPlaybookSummary,
  AdminSession,
  AdminSite,
  AdminStore,
  AdminUser,
  OperatorAuthorization,
  OperatorSession,
  TenantKeyMetadata,
  TenantOidc,
  TenantSummary,
} from './admin-store.js';

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

export interface PostgresAdminStoreOptions {
  pool: pg.Pool;
  /** The deployment key. Protects `tenant_oidc`, never read against grants here. */
  encryptionKey: Buffer;
  tenantId: string;
  /**
   * The deployment's shared Atlassian app.
   *
   * Passed in rather than read off a tenant context, because a site claim needs
   * "the app this deployment brokers through by default" and a store bound to
   * some tenant is not a reliable place to look that up.
   */
  sharedAtlassianClientId: string;
}

export class PostgresAdminStore implements AdminStore {
  readonly #pool: pg.Pool;
  readonly #key: Buffer;
  readonly #tenantId: string;
  readonly #sharedAtlassianClientId: string;

  constructor(options: PostgresAdminStoreOptions) {
    this.#pool = options.pool;
    this.#key = options.encryptionKey;
    this.#tenantId = options.tenantId;
    this.#sharedAtlassianClientId = options.sharedAtlassianClientId;
  }

  get tenantId(): string {
    return this.#tenantId;
  }

  /**
   * Tenant-scoped, with no unscoped counterpart on this class.
   *
   * `PostgresStore` needs one for the three tables that exist before a tenant is
   * known. Nothing the console touches is in that position, so the escape hatch
   * is simply absent rather than present and unused.
   */
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['renkei.tenant_id', this.#tenantId]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as Row[];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTenant(): Promise<TenantSummary | null> {
    // Readable because the transaction has already declared which tenant it is
    // acting for, and `tenants_self` permits exactly that row.
    const [row] = await this.query('SELECT id, slug, name, status FROM tenants WHERE id = $1', [
      this.#tenantId,
    ]);
    if (!row) return null;

    return {
      id: text(row.id),
      slug: text(row.slug),
      name: text(row.name),
      status: text(row.status) === 'suspended' ? 'suspended' : 'active',
    };
  }

  async getOidc(): Promise<TenantOidc | null> {
    const [row] = await this.query(
      `SELECT issuer, client_id, encrypted_client_secret, role_claim, required_role
         FROM tenant_oidc WHERE tenant_id = $1`,
      [this.#tenantId],
    );
    if (!row) return null;

    return {
      issuer: text(row.issuer),
      clientId: text(row.client_id),
      clientSecret: decrypt(text(row.encrypted_client_secret), this.#key),
      roleClaim: text(row.role_claim),
      requiredRole: textOrNull(row.required_role),
    };
  }

  async claimDomain(domain: string): Promise<boolean> {
    const rows = await this.query(
      `INSERT INTO tenant_domains (tenant_id, domain) VALUES ($1, $2)
       ON CONFLICT (domain) DO NOTHING
       RETURNING id`,
      [this.#tenantId, domain],
    );
    return rows.length > 0;
  }

  async putOperatorAuthorization(pending: OperatorAuthorization): Promise<void> {
    await this.query(
      `INSERT INTO operator_authorizations
         (state, tenant_id, nonce, code_verifier, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [pending.state, this.#tenantId, pending.nonce, pending.codeVerifier, pending.expiresAt],
    );
  }

  async takeOperatorAuthorization(state: string): Promise<OperatorAuthorization | null> {
    // DELETE ... RETURNING is what makes this single-use even under a duplicated
    // callback, the same property the delegation path's equivalent relies on.
    const [row] = await this.query(
      'DELETE FROM operator_authorizations WHERE state = $1 RETURNING *',
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

  async createOperatorSession(session: OperatorSession): Promise<void> {
    await this.query(
      `INSERT INTO operator_sessions
         (id, tenant_id, subject, display_name, token_hash, csrf_token,
          created_at, last_seen_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        session.id,
        this.#tenantId,
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

  async findOperatorSession(tokenHash: string): Promise<OperatorSession | null> {
    const [row] = await this.query('SELECT * FROM operator_sessions WHERE token_hash = $1', [
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

  async touchOperatorSession(id: string, at: string): Promise<void> {
    await this.query('UPDATE operator_sessions SET last_seen_at = $2 WHERE id = $1', [id, at]);
  }

  async revokeOperatorSession(id: string, at: string): Promise<void> {
    await this.query(
      'UPDATE operator_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, at],
    );
  }

  async purgeExpired(now: string): Promise<void> {
    await this.query('DELETE FROM operator_authorizations WHERE expires_at <= $1', [now]);
    await this.query('DELETE FROM operator_sessions WHERE expires_at <= $1', [now]);
  }

  // ------------------------------------------------------------------- sites

  async listSites(): Promise<AdminSite[]> {
    const rows = await this.query(
      `SELECT ts.*, count(ls.id) AS linked_users
         FROM tenant_sites ts
         LEFT JOIN linked_sites ls ON ls.tenant_site_id = ts.id
        WHERE ts.tenant_id = $1
        GROUP BY ts.id
        ORDER BY ts.created_at`,
      [this.#tenantId],
    );

    return rows.map((row) => ({
      id: text(row.id),
      cloudId: text(row.cloud_id),
      jiraUrl: textOrNull(row.jira_url),
      siteUrl: textOrNull(row.site_url),
      atlassianClientId: text(row.atlassian_client_id),
      enabled: row.enabled === true,
      createdAt: iso(row.created_at),
      linkedUsers: Number(row.linked_users ?? 0),
    }));
  }

  async setSiteEnabled(tenantSiteId: string, enabled: boolean): Promise<void> {
    await this.query('UPDATE tenant_sites SET enabled = $2 WHERE id = $1', [tenantSiteId, enabled]);
  }

  async claimSite(input: {
    cloudId: string;
    jiraUrl?: string;
    siteUrl?: string;
  }): Promise<{ outcome: 'claimed'; site: AdminSite } | { outcome: 'conflict' }> {
    const rows = await this.query(
      `INSERT INTO tenant_sites (tenant_id, cloud_id, jira_url, site_url, atlassian_client_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cloud_id, atlassian_client_id) DO NOTHING
       RETURNING *`,
      [
        this.#tenantId,
        input.cloudId,
        input.jiraUrl ?? null,
        input.siteUrl ?? null,
        this.#sharedAtlassianClientId,
      ],
    );

    const row = rows[0];
    if (row === undefined) return { outcome: 'conflict' };

    return {
      outcome: 'claimed',
      site: {
        id: text(row.id),
        cloudId: text(row.cloud_id),
        jiraUrl: textOrNull(row.jira_url),
        siteUrl: textOrNull(row.site_url),
        atlassianClientId: text(row.atlassian_client_id),
        enabled: row.enabled === true,
        createdAt: iso(row.created_at),
        // A freshly claimed site has no links yet.
        linkedUsers: 0,
      },
    };
  }

  // --------------------------------------------------- people, sessions, grants

  /**
   * `atlassian_grants` is joined for existence only — `count(*)`, never a
   * ciphertext column. The console is allowed to know that a credential is on
   * file and never what it is.
   */
  async listUsers(): Promise<AdminUser[]> {
    const rows = await this.query(
      `SELECT tu.account_id,
              u.display_name,
              tu.first_seen_at,
              tu.last_seen_at,
              count(DISTINCT s.id) FILTER (WHERE s.revoked_at IS NULL) AS live_sessions,
              count(DISTINCT g.cloud_id) AS grants
         FROM tenant_users tu
         JOIN users u ON u.account_id = tu.account_id
         LEFT JOIN sessions s
                ON s.atlassian_account_id = tu.account_id AND s.tenant_id = tu.tenant_id
         LEFT JOIN atlassian_grants g
                ON g.account_id = tu.account_id AND g.tenant_id = tu.tenant_id
        WHERE tu.tenant_id = $1
        GROUP BY tu.account_id, u.display_name, tu.first_seen_at, tu.last_seen_at
        ORDER BY tu.last_seen_at DESC NULLS LAST`,
      [this.#tenantId],
    );

    return rows.map((row) => ({
      accountId: text(row.account_id),
      displayName: text(row.display_name),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      liveSessions: Number(row.live_sessions ?? 0),
      hasGrant: Number(row.grants ?? 0) > 0,
    }));
  }

  async listSessions(accountId?: string): Promise<AdminSession[]> {
    const rows = await this.query(
      `SELECT s.id,
              s.atlassian_account_id,
              s.scope,
              s.created_at,
              s.last_active_at,
              s.refresh_token_expires_at,
              s.revoked_at,
              ls.tenant_site_id,
              ts.jira_url,
              ts.cloud_id,
              u.display_name,
              COALESCE(c.client_name, s.client_id) AS client_name
         FROM sessions s
         JOIN linked_sites ls ON ls.id = s.linked_site_id
         JOIN tenant_sites ts ON ts.id = ls.tenant_site_id
         JOIN users u ON u.account_id = s.atlassian_account_id
         LEFT JOIN oauth_clients c ON c.client_id = s.client_id
        WHERE s.tenant_id = $1
          AND ($2::text IS NULL OR s.atlassian_account_id = $2)
        ORDER BY s.created_at DESC`,
      [this.#tenantId, accountId ?? null],
    );

    return rows.map((row) => ({
      id: text(row.id),
      accountId: text(row.atlassian_account_id),
      displayName: text(row.display_name),
      clientName: text(row.client_name),
      tenantSiteId: text(row.tenant_site_id),
      siteJiraUrl: textOrNull(row.jira_url),
      siteCloudId: text(row.cloud_id),
      scope: Array.isArray(row.scope) ? row.scope.map(String) : [],
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_active_at),
      expiresAt: iso(row.refresh_token_expires_at),
      revokedAt: isoOrNull(row.revoked_at),
    }));
  }

  async revokeSession(sessionId: string, at: string): Promise<number> {
    const rows = await this.query(
      'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id',
      [sessionId, at],
    );
    return rows.length;
  }

  async revokeSessionsForAccount(accountId: string, at: string): Promise<number> {
    const rows = await this.query(
      `UPDATE sessions SET revoked_at = $2
        WHERE atlassian_account_id = $1 AND revoked_at IS NULL
      RETURNING id`,
      [accountId, at],
    );
    return rows.length;
  }

  /**
   * Scoped by `tenant_id`, so a contractor's grants at another tenant survive.
   *
   * Row-level security would enforce that anyway; the predicate is written out
   * because "revoke this person" meaning "everywhere they work" would be a
   * severe thing to do by omission.
   */
  async deleteGrantsForAccount(accountId: string): Promise<number> {
    const rows = await this.query(
      'DELETE FROM atlassian_grants WHERE account_id = $1 AND tenant_id = $2 RETURNING cloud_id',
      [accountId, this.#tenantId],
    );
    return rows.length;
  }

  // --------------------------------------------------------------- audit log

  async readAuditLog(options: { limit: number; before?: string }): Promise<AdminAuditRow[]> {
    // Keyset paging on `occurred_at`, which the (tenant_id, occurred_at) index
    // serves directly. OFFSET would skip rows as new ones arrive at the top.
    const rows = await this.query(
      `SELECT a.id, a.occurred_at, a.atlassian_account_id, a.tool, a.issue_keys, a.outcome,
              a.cloud_id, u.display_name
         FROM audit_log a
         LEFT JOIN users u ON u.account_id = a.atlassian_account_id
        WHERE a.tenant_id = $1
          AND ($2::timestamptz IS NULL OR a.occurred_at < $2)
        ORDER BY a.occurred_at DESC
        LIMIT $3`,
      [this.#tenantId, options.before ?? null, options.limit],
    );

    return rows.map((row) => ({
      id: String(row.id),
      occurredAt: iso(row.occurred_at),
      accountId: text(row.atlassian_account_id),
      displayName: textOrNull(row.display_name),
      tool: text(row.tool),
      issueKeys: Array.isArray(row.issue_keys) ? row.issue_keys.map(String) : [],
      outcome: text(row.outcome),
      cloudId: text(row.cloud_id),
    }));
  }

  // ----------------------------------------------------------- configuration

  async putOidc(oidc: TenantOidc): Promise<void> {
    // The issuer is stored exactly as given: OIDC Discovery §4.3 compares it for
    // equality against the provider's own document, so normalizing a trailing
    // slash is the one edit that makes every sign-in impossible.
    await this.query(
      `INSERT INTO tenant_oidc
         (tenant_id, issuer, client_id, encrypted_client_secret, role_claim, required_role,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         issuer = EXCLUDED.issuer,
         client_id = EXCLUDED.client_id,
         encrypted_client_secret = EXCLUDED.encrypted_client_secret,
         role_claim = EXCLUDED.role_claim,
         required_role = EXCLUDED.required_role,
         updated_at = now()`,
      [
        this.#tenantId,
        oidc.issuer,
        oidc.clientId,
        encrypt(oidc.clientSecret, this.#key),
        oidc.roleClaim,
        oidc.requiredRole,
      ],
    );
  }

  async revokeAllOperatorSessions(at: string): Promise<void> {
    await this.query(
      'UPDATE operator_sessions SET revoked_at = $1 WHERE tenant_id = $2 AND revoked_at IS NULL',
      [at, this.#tenantId],
    );
  }

  async getKeyMetadata(): Promise<TenantKeyMetadata> {
    // `wrapped_key` is not selected either. Absent means the deployment key,
    // which is the shape a single-organization deployment stays in.
    const [row] = await this.query(
      'SELECT source, kms_provider, kms_key_ref, updated_at FROM tenant_keys WHERE tenant_id = $1',
      [this.#tenantId],
    );

    if (!row) {
      return { source: 'deployment', kmsProvider: null, kmsKeyRef: null, updatedAt: null };
    }

    const source = text(row.source);
    return {
      source: source === 'literal' || source === 'kms' ? source : 'deployment',
      kmsProvider: textOrNull(row.kms_provider),
      kmsKeyRef: textOrNull(row.kms_key_ref),
      updatedAt: isoOrNull(row.updated_at),
    };
  }

  async setLiteralKey(wrappedKey: string): Promise<void> {
    await this.query(
      `INSERT INTO tenant_keys (tenant_id, source, wrapped_key, updated_at)
       VALUES ($1, 'literal', $2, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         source = 'literal',
         wrapped_key = EXCLUDED.wrapped_key,
         kms_provider = NULL,
         kms_key_ref = NULL,
         updated_at = now()`,
      [this.#tenantId, wrappedKey],
    );
  }

  async useDeploymentKey(): Promise<void> {
    await this.query(
      `INSERT INTO tenant_keys (tenant_id, source, wrapped_key, updated_at)
       VALUES ($1, 'deployment', NULL, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         source = 'deployment',
         wrapped_key = NULL,
         kms_provider = NULL,
         kms_key_ref = NULL,
         updated_at = now()`,
      [this.#tenantId],
    );
  }

  // ------------------------------------------------------------- playbooks

  async listPlaybooks(): Promise<AdminPlaybookSummary[]> {
    const rows = await this.query(
      `SELECT id, slug, title, enabled, updated_at FROM tenant_playbooks
       WHERE tenant_id = $1 ORDER BY title`,
      [this.#tenantId],
    );
    return rows.map(toPlaybookSummary);
  }

  async getPlaybook(slug: string): Promise<AdminPlaybook | null> {
    const [row] = await this.query(
      `SELECT id, slug, title, body_markdown, enabled, updated_at FROM tenant_playbooks
       WHERE tenant_id = $1 AND slug = $2`,
      [this.#tenantId, slug],
    );
    return row ? toPlaybook(row) : null;
  }

  async putPlaybook(input: AdminPlaybookInput): Promise<void> {
    await this.query(
      `INSERT INTO tenant_playbooks (tenant_id, slug, title, body_markdown)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, slug) DO UPDATE SET
         title = EXCLUDED.title, body_markdown = EXCLUDED.body_markdown, updated_at = now()`,
      [this.#tenantId, input.slug, input.title, input.bodyMarkdown],
    );
  }

  async deletePlaybook(slug: string): Promise<void> {
    await this.query('DELETE FROM tenant_playbooks WHERE tenant_id = $1 AND slug = $2', [
      this.#tenantId,
      slug,
    ]);
  }

  async setPlaybookEnabled(slug: string, enabled: boolean): Promise<void> {
    await this.query(
      'UPDATE tenant_playbooks SET enabled = $3, updated_at = now() WHERE tenant_id = $1 AND slug = $2',
      [this.#tenantId, slug, enabled],
    );
  }
}

function toPlaybookSummary(row: Row): AdminPlaybookSummary {
  return {
    id: text(row.id),
    slug: text(row.slug),
    title: text(row.title),
    enabled: row.enabled === true,
    updatedAt: iso(row.updated_at),
  };
}

function toPlaybook(row: Row): AdminPlaybook {
  return { ...toPlaybookSummary(row), bodyMarkdown: text(row.body_markdown) };
}
