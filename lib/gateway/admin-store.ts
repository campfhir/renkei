/**
 * What a tenant operator's console can reach, as a type.
 *
 * **This interface is where "an operator may revoke a grant but must never use
 * one" stops being a policy and becomes a fact about the program.** `GatewayStore`
 * has `getGrant`, which decrypts an Atlassian refresh token, because the
 * delegation path cannot work without it. Nothing on the admin path is ever
 * handed that object: the routes take an `AdminStore`, and there is no method
 * here that returns a token, a ciphertext, or anything a token could be
 * recovered from. `deleteGrantsForAccount` exists; no counterpart reads one.
 *
 * The second reason it is separate is scope. A `TenantContext` names a tenant
 * *and one of its sites*, which is right for every request on the delegation
 * path — a token is issued for one endpoint — and wrong for a console whose first
 * page lists every site the tenant has. An `AdminStore` is scoped to the tenant
 * and nothing narrower, so the site is an argument where it matters instead of
 * ambient state that some pages would have to work around.
 *
 * Row-level security still does the enforcing underneath: every implementation
 * sets `renkei.tenant_id` for the transaction, so a query here that forgot its
 * predicate returns nothing rather than another tenant's rows.
 */

/** The tenant itself, for the console's header and its suspension banner. */
export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
}

/**
 * The tenant's IdP registration.
 *
 * The client secret comes back decrypted because a token exchange needs it. It
 * is encrypted under the *deployment* key rather than the tenant's own: a tenant
 * cannot hold the key protecting the credential used to authenticate its own
 * operators, or losing that key would lock everyone out of the console that
 * repairs it.
 */
export interface TenantOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim: string;
  requiredRole: string | null;
}

/** The few minutes between sending an operator to their IdP and the callback. */
export interface OperatorAuthorization {
  state: string;
  nonce: string;
  /** Kept server-side. A verifier the browser could read is one an XSS could steal. */
  codeVerifier: string;
  /** PKCE code challenge (base64url of SHA256(codeVerifier)). */
  codeChallenge?: string;
  /** Device code if this auth is for a CLI device flow. */
  deviceCode?: string;
  expiresAt: string;
}

export interface OperatorSession {
  id: string;
  /** The IdP's `sub`. Not an Atlassian account ID, and never usable as one. */
  subject: string;
  displayName: string | null;
  tokenHash: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** One of the tenant's registered Jira sites, as the console lists it. */
export interface AdminSite {
  /** The UUID in `/mcp/<tenantSiteId>`. */
  id: string;
  cloudId: string;
  /** The Jira URL (domain) used to register this site. Read-only once set. */
  jiraUrl: string | null;
  /** Reported by Atlassian on the first grant. Opaque, never parsed. */
  siteUrl: string | null;
  /** The deployment's Atlassian app (configured via environment variables). */
  atlassianClientId: string;
  enabled: boolean;
  createdAt: string;
  /** How many people have linked it. */
  linkedUsers: number;
}

/**
 * A person who has used this tenant, with what the console needs to decide
 * whether to cut them off — and nothing else. No token, no ciphertext, and no
 * field a token could be recovered from.
 */
export interface AdminUser {
  accountId: string;
  displayName: string;
  firstSeenAt: string;
  lastSeenAt: string;
  liveSessions: number;
  /** Whether a stored Atlassian credential exists. Never its contents. */
  hasGrant: boolean;
}

/** A session on the console's list. Metadata only, by construction. */
export interface AdminSession {
  id: string;
  accountId: string;
  displayName: string;
  /** The client's own registration text, so the renderer escapes it. */
  clientName: string;
  /** Which endpoint it was issued for. */
  tenantSiteId: string;
  /** The site's Jira URL, for display. Null if never resolved. */
  siteJiraUrl: string | null;
  siteCloudId: string;
  scope: string[];
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** One row of the tenant's audit log. Never any issue content. */
export interface AdminAuditRow {
  id: string;
  occurredAt: string;
  accountId: string;
  displayName: string | null;
  tool: string;
  issueKeys: string[];
  outcome: string;
  cloudId: string;
}

export interface AdminStore {
  readonly tenantId: string;

  getTenant(): Promise<TenantSummary | null>;

  /** Null when the platform operator has not configured an IdP for this tenant yet. */
  getOidc(): Promise<TenantOidc | null>;

  /**
   * Writes the tenant's IdP, encrypting the client secret under the deployment key.
   *
   * Reachable from `/onboard` and from the CLI, and from nothing on the console —
   * the surface that would let an operator change their own tenant's provider is
   * the surface that provider gates, so a mistake there locks everybody out of the
   * console that repairs it. Replacing one is a fresh onboarding link, which is a
   * platform operator's decision and leaves an audit row.
   */
  putOidc(oidc: TenantOidc): Promise<void>;

  /**
   * Claims a domain for this tenant, once the self-service wizard's proof
   * (a completed login through the domain's own IdP with a matching verified
   * email) has already happened. Same table and the same global-uniqueness
   * guarantee `GatewayStore.claimDomain` writes to — declared here too so the
   * wizard's whole post-creation commit (oidc, domain, playbooks) can go
   * through the one `AdminStore` a bare tenant ID gets it, the same reason
   * the playbook methods are declared on both interfaces.
   */
  claimDomain(domain: string): Promise<boolean>;

  putOperatorAuthorization(pending: OperatorAuthorization): Promise<void>;
  /** Single use: the row is gone whether or not the caller succeeds afterwards. */
  takeOperatorAuthorization(state: string): Promise<OperatorAuthorization | null>;

  createOperatorSession(session: OperatorSession): Promise<void>;
  findOperatorSession(tokenHash: string): Promise<OperatorSession | null>;
  touchOperatorSession(id: string, at: string): Promise<void>;
  revokeOperatorSession(id: string, at: string): Promise<void>;
  /**
   * Ends every operator session this tenant has.
   *
   * Used when the tenant's IdP is replaced: those sessions were minted under a
   * provider that no longer authenticates it, and leaving them alive would mean a
   * replacement takes effect only at the next sign-in.
   */
  revokeAllOperatorSessions(at: string): Promise<void>;

  /** Drops expired operator authorizations and dead operator sessions. */
  purgeExpired(now: string): Promise<void>;

  // ------------------------------------------------------------------- sites

  listSites(): Promise<AdminSite[]>;
  /**
   * Disabling a site stops its endpoint resolving, so every token minted for it
   * fails the same way an unknown endpoint does. Sessions are left alone: this is
   * a switch, and flipping it back should not have destroyed anything.
   */
  setSiteEnabled(tenantSiteId: string, enabled: boolean): Promise<void>;

  /**
   * Claims a Jira site by cloud ID, minting the `/mcp/<id>` endpoint for it —
   * the self-service replacement for the old 3LO ownership-proof flow. No
   * proof is asked for: any authenticated operator of this tenant (who
   * already proved domain ownership to reach the console at all) can claim
   * any cloud ID, exactly as trusting as the removed `bootstrap.ts` already
   * was for every single-tenant deployment. Claiming a cloud ID only reserves
   * an endpoint; it grants no Atlassian access by itself; a guessed or
   * squatted cloud ID with no real access to it fails the moment anyone
   * actually authorizes against it.
   *
   * `conflict` means `(cloud_id, atlassian_client_id)` is already claimed —
   * by this tenant or another one.
   */
  claimSite(input: {
    cloudId: string;
    jiraUrl?: string;
    siteUrl?: string;
  }): Promise<{ outcome: 'claimed'; site: AdminSite } | { outcome: 'conflict' }>;

  // --------------------------------------------------- people, sessions, grants

  listUsers(): Promise<AdminUser[]>;
  /** Every session in the tenant, or one account's. Newest first. */
  listSessions(accountId?: string): Promise<AdminSession[]>;
  revokeSession(sessionId: string, at: string): Promise<number>;
  revokeSessionsForAccount(accountId: string, at: string): Promise<number>;

  /**
   * Deletes this account's stored Atlassian credentials for this tenant.
   *
   * The strongest thing an operator can do to a person here, and deliberately the
   * *only* thing they can do to a credential. There is no counterpart that reads
   * one: revocation without use is the whole separation this interface exists to
   * express.
   */
  deleteGrantsForAccount(accountId: string): Promise<number>;

  // --------------------------------------------------------------- audit log

  /**
   * The tenant's tool calls, newest first. `before` pages backwards by the
   * previous page's last `occurredAt`, which is stable under inserts in a way
   * OFFSET is not.
   */
  readAuditLog(options: { limit: number; before?: string }): Promise<AdminAuditRow[]>;

  // --------------------------------------------------------- configuration

  getKeyMetadata(): Promise<TenantKeyMetadata>;
  /** 32 bytes, already wrapped under the deployment key by the caller. */
  setLiteralKey(wrappedKey: string): Promise<void>;
  useDeploymentKey(): Promise<void>;

  // ------------------------------------------------------------- playbooks

  /**
   * The same rows `GatewayStore.listPlaybooks`/`getPlaybook` expose to MCP
   * clients, reachable here too because the console is where they are
   * authored. Both interfaces reach the one `tenant_playbooks` table, the
   * same shape `revokeSessionsForAccount` already takes on both stores.
   */
  listPlaybooks(): Promise<AdminPlaybookSummary[]>;
  getPlaybook(slug: string): Promise<AdminPlaybook | null>;
  putPlaybook(input: AdminPlaybookInput): Promise<void>;
  deletePlaybook(slug: string): Promise<void>;
  setPlaybookEnabled(slug: string, enabled: boolean): Promise<void>;
}

/** Which key protects this tenant's grants. Never the key itself. */
export interface TenantKeyMetadata {
  source: 'deployment' | 'literal' | 'kms';
  kmsProvider: string | null;
  kmsKeyRef: string | null;
  updatedAt: string | null;
}

/**
 * A tenant-authored playbook, as the console's list view shows it: no body.
 *
 * Structurally identical to `GatewayStore`'s `PlaybookSummary` — declared
 * separately rather than imported, to avoid a cross-file import cycle
 * between the two store interfaces.
 */
export interface AdminPlaybookSummary {
  id: string;
  slug: string;
  title: string;
  enabled: boolean;
  updatedAt: string;
}

/** The full row, including the markdown the edit form shows. */
export interface AdminPlaybook extends AdminPlaybookSummary {
  bodyMarkdown: string;
}

/** What the console's create/edit form submits. */
export interface AdminPlaybookInput {
  slug: string;
  title: string;
  bodyMarkdown: string;
}
