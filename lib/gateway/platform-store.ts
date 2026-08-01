/**
 * What the platform operator's console can reach, as a type.
 *
 * **This interface is where "a platform operator cannot read tenant data" stops
 * being a sentence in a design document and becomes a fact about the program** —
 * and, unlike `AdminStore`, it is backed up one level down as well. `AdminStore`
 * relies on nobody adding a `getGrant` to it; this interface relies on that too,
 * *and* on the `renkei_platform` role having no privilege on the tables in
 * question, so a method somebody added anyway would get a permission error rather
 * than rows. Migration 019 has the grant matrix.
 *
 * Deliberately absent, and each absence is a decision:
 *
 *   - **Nothing that returns a grant, a token, or a ciphertext.** The same rule
 *     `AdminStore` follows, one role further out.
 *   - **No site list, no user list, no audit read.** Those are facts from inside a
 *     tenant, and the role table in docs/multi-tenancy.md says this role sees none
 *     of them. `pnpm tenant list` shows a site count by joining on a privileged
 *     connection; that is an out-of-band tool, and not mirroring it here is what
 *     keeps the console's reach and the role's grants describing the same thing.
 *   - **No read of `platform_audit_log`.** Those rows describe attacks, and a
 *     request-handling path that can read them is a path an attacker can use to
 *     learn what was noticed. `/platform` is a request-handling path. Migration
 *     013 made that argument for `renkei_app`; it applies unchanged here.
 *   - **No read of a tenant's IdP client secret.** `getTenantOidcMetadata` returns
 *     which provider a tenant uses and cannot return the credential — enforced by a
 *     column-level grant, so it holds even though this process has the key.
 *
 * Unlike every other store here, implementations set **no** `renkei.tenant_id`:
 * spanning tenants is this role's whole purpose, and the isolation comes from the
 * grants instead. That absence is called out in the Postgres implementation too, so
 * it cannot be mistaken for the missing-`SET LOCAL` bug migration 013 warns about.
 */

/** A tenant as the platform console sees it: identity and status, nothing inside. */
export interface PlatformTenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
  /** Whether an IdP is configured, never what it is. */
  hasOidc: boolean;
  /** Live, unredeemed, unexpired onboarding links for this tenant. */
  pendingOnboardingTokens: number;
}

/** Which provider a tenant uses. Never the credential — see the class comment. */
export interface TenantOidcMetadata {
  issuer: string;
  clientId: string;
  roleClaim: string;
  requiredRole: string | null;
  updatedAt: string;
}

/** The few minutes between sending a platform operator to the IdP and the callback. */
export interface PlatformAuthorization {
  state: string;
  nonce: string;
  /** Server-side: a verifier the browser could read is one an XSS could steal. */
  codeVerifier: string;
  expiresAt: string;
}

export interface PlatformSession {
  id: string;
  subject: string;
  displayName: string | null;
  tokenHash: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * An onboarding capability, as the console sees it.
 *
 * No `tokenHash`, and no way to recover the secret: the link is rendered once, to
 * the browser that caused it to exist, and after that the only things anybody can
 * do with the row are look at its state and revoke it.
 */
export interface OnboardingTokenSummary {
  id: string;
  tenantId: string;
  allowReplace: boolean;
  issuedBySubject: string;
  issuedAt: string;
  expiresAt: string;
  attempts: number;
  redeemedAt: string | null;
  revokedAt: string | null;
}

export interface NewOnboardingToken {
  tenantId: string;
  tokenHash: string;
  allowReplace: boolean;
  issuedBySubject: string;
  expiresAt: string;
}

export interface NotificationRecord {
  id: string;
  channel: 'console';
  recipient: string;
  subject: string;
  body: string;
  tenantId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  acknowledgedAt: string | null;
}

export interface NewNotification {
  channel: 'console';
  recipient: string;
  subject: string;
  body: string;
  tenantId: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
}

export interface PlatformStore {
  /** Throws when the connection or its privileges are wrong. Called at boot. */
  assertReachable(): Promise<void>;

  // ------------------------------------------------------------------ tenants

  listTenants(): Promise<PlatformTenant[]>;
  findTenantBySlug(slug: string): Promise<PlatformTenant | null>;
  /**
   * Creates a tenant, or null when the slug is taken.
   *
   * Null rather than an upsert: silently renaming somebody else's tenant is worse
   * than being told the name is gone. `pnpm tenant create` makes the same choice.
   */
  createTenant(slug: string, name: string): Promise<PlatformTenant | null>;
  setTenantStatus(slug: string, status: 'active' | 'suspended'): Promise<boolean>;
  getTenantOidcMetadata(tenantId: string): Promise<TenantOidcMetadata | null>;

  // -------------------------------------------------------- onboarding links

  createOnboardingToken(token: NewOnboardingToken): Promise<OnboardingTokenSummary>;
  listOnboardingTokens(tenantId: string): Promise<OnboardingTokenSummary[]>;
  /** Revokes one, by id and tenant. False when it was already gone or redeemed. */
  revokeOnboardingToken(id: string, at: string): Promise<boolean>;

  // -------------------------------------------------------------- the console

  putPlatformAuthorization(pending: PlatformAuthorization): Promise<void>;
  /** Single-use: a `DELETE ... RETURNING`, so a duplicated callback finds nothing. */
  takePlatformAuthorization(state: string): Promise<PlatformAuthorization | null>;
  createPlatformSession(session: PlatformSession): Promise<void>;
  findPlatformSession(tokenHash: string): Promise<PlatformSession | null>;
  touchPlatformSession(id: string, at: string): Promise<void>;
  revokePlatformSession(id: string, at: string): Promise<void>;

  // ------------------------------------------------------------ notifications

  createNotification(notification: NewNotification): Promise<NotificationRecord>;
  listNotifications(limit: number): Promise<NotificationRecord[]>;
  acknowledgeNotification(id: string, at: string): Promise<void>;

  /** Expired sign-in state, and notification bodies whose token is dead. */
  purgeExpired(now: string): Promise<void>;

  close(): Promise<void>;
}

/**
 * A double with the same observable behaviour, so the whole `/platform` surface is
 * drivable without a database.
 *
 * It cannot imitate the grants, which is the point of the Postgres-backed
 * assertions in `test/gateway/rls.test.ts`: what this proves is the routes, and
 * what those prove is the isolation.
 */
export class InMemoryPlatformStore implements PlatformStore {
  readonly tenants = new Map<string, PlatformTenant>();
  readonly oidc = new Map<string, TenantOidcMetadata>();
  /**
   * Keyed by token hash, mirroring the unique index — and deliberately the same
   * map `InMemoryStore` can be pointed at, because production has one table that
   * the platform role inserts into and the application role spends from. Two
   * unlinked maps would let a test pass on a pair of halves that could never see
   * each other's rows.
   */
  readonly onboardingTokens = new Map<string, OnboardingTokenSummary>();
  readonly authorizations = new Map<string, PlatformAuthorization>();
  readonly sessions = new Map<string, PlatformSession>();
  readonly notifications = new Map<string, NotificationRecord>();

  #sequence = 0;

  #id(kind: string): string {
    this.#sequence += 1;
    // Shaped like a UUID because routes and pages treat these as opaque ids, and a
    // double that hands back something unparseable would hide a real formatting bug.
    return `00000000-0000-4000-8000-${kind.slice(0, 4).padEnd(4, '0')}${String(this.#sequence).padStart(8, '0')}`;
  }

  assertReachable(): Promise<void> {
    return Promise.resolve();
  }

  listTenants(): Promise<PlatformTenant[]> {
    return Promise.resolve(
      [...this.tenants.values()]
        .map((tenant) => this.#withCounts(tenant))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    );
  }

  findTenantBySlug(slug: string): Promise<PlatformTenant | null> {
    const tenant = [...this.tenants.values()].find((candidate) => candidate.slug === slug);
    return Promise.resolve(tenant === undefined ? null : this.#withCounts(tenant));
  }

  #withCounts(tenant: PlatformTenant): PlatformTenant {
    return {
      ...tenant,
      hasOidc: this.oidc.has(tenant.id),
      pendingOnboardingTokens: [...this.onboardingTokens.values()].filter(
        (token) =>
          token.tenantId === tenant.id && token.redeemedAt === null && token.revokedAt === null,
      ).length,
    };
  }

  createTenant(slug: string, name: string): Promise<PlatformTenant | null> {
    if ([...this.tenants.values()].some((tenant) => tenant.slug === slug)) {
      return Promise.resolve(null);
    }

    const tenant: PlatformTenant = {
      id: this.#id('tnnt'),
      slug,
      name,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      hasOidc: false,
      pendingOnboardingTokens: 0,
    };
    this.tenants.set(tenant.id, tenant);
    return Promise.resolve(tenant);
  }

  setTenantStatus(slug: string, status: 'active' | 'suspended'): Promise<boolean> {
    const tenant = [...this.tenants.values()].find((candidate) => candidate.slug === slug);
    if (tenant === undefined) return Promise.resolve(false);

    this.tenants.set(tenant.id, { ...tenant, status });
    return Promise.resolve(true);
  }

  getTenantOidcMetadata(tenantId: string): Promise<TenantOidcMetadata | null> {
    return Promise.resolve(this.oidc.get(tenantId) ?? null);
  }

  createOnboardingToken(token: NewOnboardingToken): Promise<OnboardingTokenSummary> {
    const summary: OnboardingTokenSummary = {
      id: this.#id('onbd'),
      tenantId: token.tenantId,
      allowReplace: token.allowReplace,
      issuedBySubject: token.issuedBySubject,
      issuedAt: new Date(0).toISOString(),
      expiresAt: token.expiresAt,
      attempts: 0,
      redeemedAt: null,
      revokedAt: null,
    };
    // Keyed by hash so `InMemoryStore`'s redemption half can find it, mirroring the
    // unique index. The summary itself never carries the hash.
    this.onboardingTokens.set(token.tokenHash, summary);
    return Promise.resolve(summary);
  }

  listOnboardingTokens(tenantId: string): Promise<OnboardingTokenSummary[]> {
    return Promise.resolve(
      [...this.onboardingTokens.values()].filter((token) => token.tenantId === tenantId),
    );
  }

  revokeOnboardingToken(id: string, at: string): Promise<boolean> {
    for (const [hash, token] of this.onboardingTokens) {
      if (token.id !== id) continue;
      if (token.redeemedAt !== null || token.revokedAt !== null) return Promise.resolve(false);

      this.onboardingTokens.set(hash, { ...token, revokedAt: at });
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  putPlatformAuthorization(pending: PlatformAuthorization): Promise<void> {
    this.authorizations.set(pending.state, pending);
    return Promise.resolve();
  }

  takePlatformAuthorization(state: string): Promise<PlatformAuthorization | null> {
    const pending = this.authorizations.get(state) ?? null;
    this.authorizations.delete(state);
    return Promise.resolve(pending);
  }

  createPlatformSession(session: PlatformSession): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  findPlatformSession(tokenHash: string): Promise<PlatformSession | null> {
    return Promise.resolve(
      [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null,
    );
  }

  touchPlatformSession(id: string, at: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session !== undefined) this.sessions.set(id, { ...session, lastSeenAt: at });
    return Promise.resolve();
  }

  revokePlatformSession(id: string, at: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session !== undefined) this.sessions.set(id, { ...session, revokedAt: at });
    return Promise.resolve();
  }

  createNotification(notification: NewNotification): Promise<NotificationRecord> {
    const record: NotificationRecord = {
      id: this.#id('note'),
      ...notification,
      createdAt: new Date(0).toISOString(),
      acknowledgedAt: null,
    };
    this.notifications.set(record.id, record);
    return Promise.resolve(record);
  }

  listNotifications(limit: number): Promise<NotificationRecord[]> {
    return Promise.resolve([...this.notifications.values()].reverse().slice(0, limit));
  }

  acknowledgeNotification(id: string, at: string): Promise<void> {
    const record = this.notifications.get(id);
    if (record !== undefined) this.notifications.set(id, { ...record, acknowledgedAt: at });
    return Promise.resolve();
  }

  purgeExpired(now: string): Promise<void> {
    for (const [state, pending] of this.authorizations) {
      if (Date.parse(pending.expiresAt) <= Date.parse(now)) this.authorizations.delete(state);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
