/**
 * Everything the gateway persists, and an in-memory implementation of it.
 *
 * Six kinds of record, and nothing else — no Jira data is stored anywhere:
 *
 *   - OAuth clients        the MCP clients allowed to ask for a session
 *   - pending authorizations  the few seconds between /authorize and the
 *                          Atlassian callback
 *   - authorization codes  single-use, PKCE-bound, redeemed at /token
 *   - sessions             Renkei's own access/refresh pair for one user
 *   - portal sessions      one human's cookie on /me, a separate kind of thing
 *   - Atlassian grants     the user's real token, encrypted at rest
 *
 * Plus the audit log, which is append-only and holds no content, and the
 * platform log, which the application can write and cannot read back.
 *
 * The interface is the seam that lets the whole OAuth surface be tested
 * without a database. `PostgresStore` in ./postgres-store.ts is the one that
 * runs in production; this file's `InMemoryStore` is a test double and a
 * single-process development convenience — it loses every session on restart,
 * which is exactly what you do not want in a deployment.
 *
 * The operator console's records are deliberately *not* here. They live behind
 * `AdminStore` in ./admin-store.ts, which is scoped to a tenant rather than to
 * one of its sites and which has no method that can return a decrypted grant —
 * see that file for why the split is the point rather than tidiness.
 */

import type { AuditEvent } from '../audit/logger.js';
import type { Grant, TokenStore } from '../auth/token-store.js';
import { generateSecret, hashToken } from './tokens.js';
import type {
  AdminAuditRow,
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
// The double's onboarding map is typed as the console's row so both in-memory
// stores can share one; production reaches one table by two roles.
import type { OnboardingTokenSummary } from './platform-store.js';

/**
 * The tenant and site a scoped `GatewayStore` acts for.
 *
 * Every real one comes from `resolveEndpoint`/`resolveSiteClaim` resolving a
 * `/mcp/<tenantSiteId>` or a claimed cloud ID to a live row — there is no
 * boot-time "the deployment's configured tenant" anymore (that was
 * `bootstrap.ts`, removed in favor of the self-service wizard and
 * `pnpm tenant claim-site`, both of which create ordinary rows through the
 * same paths an operator would).
 */
export interface TenantContext {
  tenantId: string;
  /** The `/mcp/<tenantSiteId>` this context answers on. */
  tenantSiteId: string;
  cloudId: string;
  atlassianClientId: string;
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  /** Exact-match list. A redirect URI not in here is never redirected to. */
  redirectUris: string[];
  /**
   * SHA-256 of the issued secret, or null for a public client. A public client
   * is authenticated by PKCE alone, which is what the MCP spec expects of
   * clients that cannot hold a secret.
   */
  secretHash: string | null;
  scope: string[];
  createdAt: string;
}

/**
 * State held between redirecting the user to Atlassian and Atlassian calling
 * back. Keyed by the `state` Renkei generates for the Atlassian leg, which
 * is what binds the callback to this request.
 *
 * A union rather than one shape with nullable fields, because the flows
 * that come back to `/oauth/callback` genuinely differ: an MCP authorization
 * owes a code to a client at a validated redirect URI, a portal sign-in
 * owes a cookie to the browser, and an MCP reauth updates an existing session's grant.
 * Making that a discriminant means the compiler refuses a redirect built from
 * a row that has nowhere to redirect.
 */
export type PendingAuthorization = PendingMcpAuthorization | PendingPortalSignIn | PendingMcpReauth;

export interface PendingMcpAuthorization {
  kind: 'mcp';
  brokerState: string;
  clientId: string;
  redirectUri: string;
  /** The MCP client's own `state`, echoed back untouched. */
  clientState: string | null;
  /** S256 challenge. Verified against the verifier at /token. */
  codeChallenge: string;
  scope: string[];
  /** RFC 8707 `resource`, when the client sent one. */
  resource: string | null;
  expiresAt: string;
}

/**
 * A user signing in to `/me` from this deployment's own page.
 *
 * Carries no resource: the site is not known yet. The user picks one on
 * Atlassian's consent screen, and which tenant that turns out to be is settled
 * afterwards from the registered site claims.
 */
export interface PendingPortalSignIn {
  kind: 'portal';
  brokerState: string;
  expiresAt: string;
}

/**
 * An MCP session re-authenticating to refresh its Jira token.
 *
 * Similar to MCP authorization but updates an existing session's grant
 * instead of creating a new session. The sessionId is used to look up
 * and update the grant after the OAuth flow completes.
 */
export interface PendingMcpReauth {
  kind: 'mcp_reauth';
  brokerState: string;
  sessionId: string;
  clientState: string | null;
  expiresAt: string;
}

export interface AuthorizationCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  accountId: string;
  scope: string[];
  resource: string | null;
  expiresAt: string;
  /**
   * The session this code produced, set when it is redeemed. A code presented
   * twice is an interception signal, and the session it minted is revoked.
   */
  redeemedSessionId: string | null;
}

/**
 * A temporary state token for MCP session re-authentication.
 *
 * Single-use token that allows a session to initiate re-auth without
 * exposing the actual bearer token in a URL. Expires quickly and is
 * consumed on first use.
 */
export interface ReauthState {
  stateHash: string;
  sessionId: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface Session {
  id: string;
  clientId: string;
  accountId: string;
  /**
   * The `/mcp/<tenantSiteId>` this session was issued for.
   *
   * RFC 8707 audience binding, made checkable. Row-level security already stops
   * a token reaching another *tenant's* endpoint, but a tenant with two
   * registered sites needs this too: a token minted for one of its sites must
   * not work at the other, or the per-site consent the user gave means nothing.
   */
  tenantSiteId: string;
  scope: string[];
  accessTokenHash: string;
  refreshTokenHash: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  /** Drives the inactivity timeout. */
  lastSeenAt: string;
  revokedAt: string | null;
}

/**
 * One human's signed-in browser on `/me`.
 *
 * Bound to a site, not just a tenant, because that is what the Atlassian round
 * trip proved: consent carries a site picker, so signing in establishes access
 * to the one site the user chose. The same audience binding `Session` carries,
 * for the same reason.
 */
export interface PortalSession {
  id: string;
  tenantSiteId: string;
  accountId: string;
  tokenHash: string;
  /** Rendered into every form on the page and required back on every POST. */
  csrfToken: string;
  createdAt: string;
  /** Drives the idle timeout. */
  lastSeenAt: string;
  /** The outer bound. No amount of activity extends it. */
  expiresAt: string;
  revokedAt: string | null;
}

/** A user's binding to one of their tenant's registered sites. */
export interface LinkedSite {
  id: string;
  tenantSiteId: string;
  accountId: string;
  /** What this user calls it. Display only, and theirs alone. */
  label: string | null;
  /** From Atlassian, filled in on the first grant. Opaque — never parsed. */
  siteUrl: string | null;
  createdAt: string;
}

/**
 * A session as the portal shows it to its owner: enough to recognize which
 * client this is and decide whether to keep it, and no token material.
 */
export interface SessionSummary {
  id: string;
  /** From the client's own registration, so it is attacker-supplied text. */
  clientName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * An event that never resolved to a tenant, or resolved to one the caller had
 * no business reaching. Write-only to the application — see migration 013.
 */
/**
 * An onboarding link, as the half of the flow that redeems it sees.
 *
 * No secret and no hash on the way out: a caller already had to present the secret
 * to get here, and nothing downstream needs it again.
 */
export interface OnboardingToken {
  id: string;
  tenantId: string;
  allowReplace: boolean;
  expiresAt: string;
  attempts: number;
  redeemedAt: string | null;
  revokedAt: string | null;
}

/**
 * The self-service wizard's own transient state — see migration 029. Single
 * use: `takePendingOrgSignup` deletes the row whether the callback succeeds
 * or not, the same as `takePendingAuthorization`.
 */
export interface PendingOrgSignup {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Candidate, not yet reserved. */
  slug: string;
  orgName: string;
  /** Candidate, not yet claimed. Lowercased. */
  domain: string;
  issuer: string;
  clientId: string;
  encryptedClientSecret: string;
  roleClaim: string;
  requiredRole: string | null;
  expiresAt: string;
}

export interface PlatformAuditEvent {
  event:
    | 'unknown_endpoint'
    | 'invalid_token'
    | 'cross_tenant_token'
    | 'tenant_suspended'
    | 'user_revoked'
    | 'site_registration'
    | 'operator_sign_in'
    | 'user_sign_in'
    /** A CLI sign-in reaching the confirmation step. `denied` is the row that matters. */
    | 'device_authorization'
    /**
     * The platform console. Separate from `operator_sign_in` because that event's
     * `target_tenant_id` names the tenant whose IdP authenticated somebody, and
     * this one has no tenant at all — folding them would file deployment-wide
     * access under the same name as tenant-scoped access.
     */
    | 'platform_sign_in'
    | 'platform_tenant_create'
    /**
     * Note this is not `tenant_suspended`, which already exists and means the
     * opposite thing: that is written by the request path when somebody *reaches*
     * a suspended tenant. Reusing it would collide "a tenant was suspended" with
     * "a suspended tenant was used" in the column an incident review filters on.
     */
    | 'platform_tenant_suspend'
    | 'platform_tenant_resume'
    /** Who was handed the ability to configure which tenant's operator sign-in. */
    | 'platform_onboarding_issued'
    /** Attributable to an IP and a token, and to no session of any kind. */
    | 'tenant_onboarding_redeemed'
    /** The highest-severity act here: repointing who can operate a tenant. */
    | 'tenant_oidc_replaced'
    | 'rate_limited';
  outcome: 'success' | 'failure' | 'denied';
  sourceIp: string | null;
  userAgent: string | null;
  /** A path, never a query string — that is where tokens end up. */
  requestPath: string | null;
  targetTenantId: string | null;
  accountId: string | null;
}

export interface SessionRotation {
  accessTokenHash: string;
  refreshTokenHash: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  at: string;
}

/** A tenant-authored playbook, as the list view shows it: no body. */
export interface PlaybookSummary {
  id: string;
  slug: string;
  title: string;
  enabled: boolean;
  updatedAt: string;
}

/** The full row, including the markdown a `get_playbook` call returns. */
export interface Playbook extends PlaybookSummary {
  bodyMarkdown: string;
}

/** What authoring a playbook through the console submits. */
export interface PlaybookInput {
  slug: string;
  title: string;
  bodyMarkdown: string;
}

/**
 * One in-flight CLI sign-in.
 *
 * The two codes are not interchangeable, and neither is a credential on its own.
 * The `deviceCode` is what the CLI polls with and is known to whoever started the
 * flow — which, in the attack this shape exists to stop, is not the operator. The
 * `userCode` is what the operator reads off their terminal and types into the
 * browser.
 *
 * `idToken` is present as soon as the operator has authenticated, but the CLI
 * cannot have it until `approvedAt` is set. That gap is the whole point: signing
 * in proves who you are, and approving proves you meant to hand a token to *this*
 * device. `approvalToken` is the unguessable handle for the second step, minted
 * after authentication and delivered only to the browser that completed it, so
 * whoever started the flow cannot skip ahead by replaying a code they already
 * know.
 */
export interface DeviceAuthorizationRecord {
  deviceCode: string;
  userCode: string;
  tenantSlug: string;
  issuedAt: number;
  expiresAt: number;
  /** Set only by an explicit approval. Until then the CLI gets `authorization_pending`. */
  approvedAt?: number;
  operatorSubject?: string;
  /** Held back from the CLI until `approvedAt` is set. */
  idToken?: string;
  /** Cleared on approval, so the confirmation cannot be replayed. */
  approvalToken?: string;
}

export interface GatewayStore {
  /**
   * The tenant and site this store instance acts for.
   *
   * On the interface rather than only on the Postgres implementation, because
   * callers need it to stamp a session with the endpoint it was issued for,
   * and a store that could not say which tenant it was bound to would make
   * that a parameter every call site could get wrong.
   */
  readonly tenant: TenantContext;

  /**
   * Turns a `/mcp/<tenantSiteId>` into the tenant behind it, or null when the
   * endpoint is unknown or its tenant is suspended — the caller must not be
   * able to tell those apart.
   */
  resolveEndpoint(tenantSiteId: string): Promise<TenantContext | null>;

  /**
   * The same resolution from the other direction: which registered site is this
   * `(cloud id, Atlassian app)` pair, if any?
   *
   * The portal needs it because a sign-in discovers its site rather than being
   * told one — the user picks on Atlassian's consent screen and a cloud ID comes
   * back. Null for unregistered, disabled, and suspended alike.
   */
  resolveSiteClaim(cloudId: string, atlassianClientId: string): Promise<TenantContext | null>;

  /**
   * The tenant behind an `/admin/<slug>`, or null when the slug is unknown or
   * its tenant is suspended.
   *
   * Returns a bare tenant ID rather than a `TenantContext`, because an operator
   * acts for a tenant and not for one of its sites — the console's first page
   * lists all of them.
   */
  resolveSlug(slug: string): Promise<{ tenantId: string } | null>;

  /**
   * The tenant a claimed email domain belongs to, for home-realm discovery at
   * `/`.
   *
   * Null only for "no tenant has claimed this domain" — unlike `resolveSlug`,
   * a suspended tenant is reported as such (`active: false`) rather than
   * folded into null, because `/` shows a different message for "your
   * organization's access is suspended" than for "nobody has signed up with
   * this domain yet."
   */
  resolveDomain(
    domain: string,
  ): Promise<{ tenantId: string; slug: string; active: boolean } | null>;

  /**
   * Claims a domain for this store's tenant, once home-realm-discovery proof
   * (a completed login through the domain's own IdP with a matching verified
   * email) has already happened — this method does not itself verify
   * anything, it only persists the claim.
   *
   * `domain` is globally unique (migration 028), so this can lose a race to
   * another tenant claiming the same domain in the interval between the
   * wizard's pre-check and this call. Returns `false` in that case rather
   * than throwing, so the caller can show a clear message instead of a raw
   * constraint-violation error.
   */
  claimDomain(domain: string): Promise<boolean>;

  /**
   * The console's view of one tenant, sharing this store's connections.
   *
   * A different interface rather than a scoped `GatewayStore`: an operator must
   * never be handed an object that can decrypt a grant. See ./admin-store.ts.
   */
  admin(tenantId: string): AdminStore;

  /** The self-service wizard's own pending state — see `PendingOrgSignup`. */
  putPendingOrgSignup(signup: PendingOrgSignup): Promise<void>;
  /** Single use: the row is gone whether or not the caller succeeds afterwards. */
  takePendingOrgSignup(state: string): Promise<PendingOrgSignup | null>;

  /**
   * Looks up an onboarding link without consuming it.
   *
   * On this interface, and not on `PlatformStore`, because the two halves of the
   * flow run on two different database roles: the platform role mints and revokes,
   * the application role redeems. `renkei_app` is granted SELECT and UPDATE on
   * the table and deliberately not INSERT, so nothing on the delegation path can
   * create a capability — only spend one.
   *
   * Reading rather than consuming is the difference from every other single-use
   * lookup here. A `state` is a replay handle for a flow that has already left the
   * browser, so it must burn even on a failure; this is a capability somebody is
   * exercising interactively, and burning it on a typo would be a denial of
   * service against the tenant. `recordOnboardingAttempt` is the ceiling that
   * keeps the retry allowance from becoming an oracle.
   */
  findOnboardingToken(tokenHash: string): Promise<OnboardingToken | null>;

  /** One failed redemption. Counted so a link cannot be ground against forever. */
  recordOnboardingAttempt(tokenHash: string): Promise<void>;

  /**
   * Spends a link, or returns null if somebody else already did.
   *
   * One conditional UPDATE, so single-use holds under two concurrent redemptions
   * without a lock: the second matches no row and gets null.
   */
  redeemOnboardingToken(tokenHash: string, at: string): Promise<OnboardingToken | null>;

  /** A view of this store bound to another tenant, sharing its connections. */
  forTenant(tenant: TenantContext): GatewayStore;

  /**
   * Records that this account intends to use this tenant's site, and that they
   * are a user of the tenant. Both derived from consenting at the endpoint
   * rather than from any invitation.
   */
  linkSite(accountId: string): Promise<void>;

  /** This account's link to this store's site, or null if it has none. */
  getLinkedSite(accountId: string): Promise<LinkedSite | null>;

  /** Names the link. Null clears it. Display only, and only this user sees it. */
  setLinkedSiteLabel(accountId: string, label: string | null): Promise<void>;

  createClient(client: OAuthClient): Promise<void>;
  findClient(clientId: string): Promise<OAuthClient | null>;

  putPendingAuthorization(pending: PendingAuthorization): Promise<void>;
  /** Single use: the row is gone whether or not the caller succeeds afterwards. */
  takePendingAuthorization(brokerState: string): Promise<PendingAuthorization | null>;

  putAuthorizationCode(code: AuthorizationCode): Promise<void>;
  /**
   * Reads the code and marks it redeemed in one step. Returns the row as it
   * was *before* the update, so a caller can tell a first redemption
   * (`redeemedSessionId === null`) from a replay.
   */
  redeemAuthorizationCode(codeHash: string, sessionId: string): Promise<AuthorizationCode | null>;

  upsertUser(accountId: string, displayName: string): Promise<void>;
  putGrant(grant: Grant): Promise<void>;
  getGrant(accountId: string): Promise<Grant | null>;
  deleteGrant(accountId: string): Promise<void>;

  createSession(session: Session): Promise<void>;
  findSessionById(id: string): Promise<Session | null>;
  findSessionByAccessToken(hash: string): Promise<Session | null>;
  findSessionByRefreshToken(hash: string): Promise<Session | null>;
  rotateSession(id: string, rotation: SessionRotation): Promise<void>;
  touchSession(id: string, at: string): Promise<void>;
  revokeSession(id: string, at: string): Promise<void>;
  /** Admin revocation path: kills every session for a user. Returns the count. */
  revokeSessionsForAccount(accountId: string, at: string): Promise<number>;

  /**
   * This account's sessions at this store's site, newest first, as the portal
   * shows them. Revoked ones are included: "that connector I removed is gone"
   * is worth being able to confirm.
   */
  listSessionsForSite(accountId: string): Promise<SessionSummary[]>;

  /**
   * Kills this account's sessions at this store's site only.
   *
   * Narrower than `revokeSessionsForAccount`, which reaches every site in the
   * tenant. The portal is the user's own control over one connection, and
   * disconnecting one site must not silently take out another.
   */
  revokeSessionsForSite(accountId: string, at: string): Promise<number>;

  // ----------------------------------------------------------- reauth state

  /** Creates a temporary single-use state token for session re-authentication. */
  createReauthState(sessionId: string, expiresAt: string): Promise<string>;
  /** Finds and marks a reauth state as used. Returns the sessionId if valid and unused. */
  consumeReauthState(state: string): Promise<string | null>;

  // ----------------------------------------------------------- portal sessions

  createPortalSession(session: PortalSession): Promise<void>;
  findPortalSession(tokenHash: string): Promise<PortalSession | null>;
  /** Slides the idle timeout forward. */
  touchPortalSession(id: string, at: string): Promise<void>;
  revokePortalSession(id: string, at: string): Promise<void>;

  // ----------------------------------------------------------- device authorization

  saveDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void>;
  getDeviceAuthorization(deviceCode: string): Promise<DeviceAuthorizationRecord | null>;
  getDeviceAuthorizationByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null>;
  /** The handle the confirmation page carries. Only a browser that authenticated has one. */
  getDeviceAuthorizationByApprovalToken(
    approvalToken: string,
  ): Promise<DeviceAuthorizationRecord | null>;
  deleteDeviceAuthorization(deviceCode: string): Promise<void>;

  // ----------------------------------------------------------- playbooks

  /**
   * On `GatewayStore` rather than `AdminStore`: a playbook has to be readable
   * from the MCP tool path (`ToolContext`, built from this store in
   * mcp-route.ts), not only from the console. The console CRUD page calls
   * these same methods through the `GatewayStore` it already holds.
   */
  listPlaybooks(): Promise<PlaybookSummary[]>;
  getPlaybook(slug: string): Promise<Playbook | null>;
  /** Upserts by `(tenant_id, slug)`. */
  putPlaybook(input: PlaybookInput): Promise<void>;
  deletePlaybook(slug: string): Promise<void>;
  setPlaybookEnabled(slug: string, enabled: boolean): Promise<void>;

  writeAuditEvent(event: AuditEvent): Promise<void>;

  /**
   * Records something that had no tenant, or reached the wrong one. Never read
   * back through this interface, because the application role cannot read the
   * table it writes to — these are the rows that describe attacks.
   */
  writePlatformAuditEvent(event: PlatformAuditEvent): Promise<void>;

  /** Drops expired codes, pending authorizations, and dead sessions. */
  purgeExpired(now: string): Promise<void>;

  close(): Promise<void>;
}

/**
 * Adapts one user's row in the gateway store to the `TokenStore` interface the
 * Atlassian `TokenProvider` already speaks. Refresh rotation, single-flight,
 * and site pinning are therefore identical on both transports — the only
 * difference is where the grant lives.
 */
export class ScopedGrantStore implements TokenStore {
  readonly #store: GatewayStore;
  readonly #accountId: string;

  constructor(store: GatewayStore, accountId: string) {
    this.#store = store;
    this.#accountId = accountId;
  }

  read(): Promise<Grant | null> {
    return this.#store.getGrant(this.#accountId);
  }

  async write(grant: Grant): Promise<void> {
    if (grant.accountId !== this.#accountId) {
      // A rotated grant that changed identity would overwrite another user's
      // row. This cannot happen through TokenProvider, which copies the field
      // forward, but the store is the wrong place to find that out.
      throw new Error(
        `refusing to write a grant for ${grant.accountId} into ${this.#accountId}'s slot`,
      );
    }
    await this.#store.putGrant(grant);
  }

  clear(): Promise<void> {
    return this.#store.deleteGrant(this.#accountId);
  }
}

// ---------------------------------------------------------------- in-memory

/** `InMemoryStore`'s default `tenantSiteId`, for tests that need to address it by URL. */
export const DEFAULT_TENANT_SITE_ID = '00000000-0000-4000-8000-000000000002';

/**
 * Test double. Holds tokens in plaintext and everything in process memory, so
 * it is not a deployment option — `PostgresStore` is.
 */
export class InMemoryStore implements GatewayStore {
  /**
   * A single fixed tenant. This double exists to test the OAuth surface without
   * a database, and tenant isolation is enforced by row-level security, which
   * an in-memory map cannot imitate — pretending otherwise would produce tests
   * that pass here and prove nothing about production. Cross-tenant behaviour
   * is covered in test/gateway/rls.test.ts against real Postgres.
   */
  readonly tenant: TenantContext;

  readonly clients = new Map<string, OAuthClient>();
  readonly pending = new Map<string, PendingAuthorization>();
  readonly codes = new Map<string, AuthorizationCode>();
  readonly sessions = new Map<string, Session>();
  readonly grants = new Map<string, Grant>();
  readonly users = new Map<string, string>();
  readonly links = new Map<string, LinkedSite>();
  readonly portalSessions = new Map<string, PortalSession>();
  readonly reauthStates = new Map<string, ReauthState>();
  readonly playbooks = new Map<string, Playbook>();
  /** Domains claimed for `this.tenant`, as in a real deployment's `tenant_domains`. */
  readonly domains = new Set<string>();
  readonly audit: AuditEvent[] = [];
  readonly platformAudit: PlatformAuditEvent[] = [];

  // ---- the console's state, reachable through `admin()` and seedable directly

  /** The `/admin/<slug>` this double answers for. */
  slug = 'test-tenant';
  name = 'Test tenant';
  status: 'active' | 'suspended' = 'active';
  siteEnabled = true;
  /** Null until a platform operator configures an IdP, as in a real deployment. */
  oidc: TenantOidc | null = null;
  readonly operatorAuthorizations = new Map<string, OperatorAuthorization>();
  readonly operatorSessions = new Map<string, OperatorSession>();
  tenantKey: TenantKeyMetadata & { wrappedKey: string | null } = {
    source: 'deployment',
    kmsProvider: null,
    kmsKeyRef: null,
    updatedAt: null,
    wrappedKey: null,
  };

  constructor(tenant?: Partial<TenantContext>) {
    this.tenant = {
      tenantId: '00000000-0000-4000-8000-000000000001',
      tenantSiteId: DEFAULT_TENANT_SITE_ID,
      cloudId: 'cloud-in-memory',
      atlassianClientId: 'client-in-memory',
      ...tenant,
    };
  }

  linkSite(accountId: string): Promise<void> {
    if (!this.links.has(accountId)) {
      this.links.set(accountId, {
        id: `link-${accountId}`,
        tenantSiteId: this.tenant.tenantSiteId,
        accountId,
        label: null,
        siteUrl: this.grants.get(accountId)?.siteUrl ?? null,
        createdAt: new Date().toISOString(),
      });
    }
    return Promise.resolve();
  }

  getLinkedSite(accountId: string): Promise<LinkedSite | null> {
    const link = this.links.get(accountId);
    if (!link) return Promise.resolve(null);
    // The site URL is unknown until a grant reports it, so read it through
    // rather than caching a null taken at link time.
    return Promise.resolve({
      ...link,
      siteUrl: this.grants.get(accountId)?.siteUrl ?? link.siteUrl,
    });
  }

  setLinkedSiteLabel(accountId: string, label: string | null): Promise<void> {
    const link = this.links.get(accountId);
    if (link) {
      this.links.set(accountId, { ...link, label });
    }
    return Promise.resolve();
  }

  /**
   * Only ever resolves its own single endpoint; see the note on `tenant`.
   *
   * Honours `siteEnabled` and `status` the way `renkei_resolve_endpoint` folds
   * them into one `active` flag, so "an operator disabled this site" and "no such
   * site" are the same answer here too — which is what makes the console's switch
   * testable without a database.
   */
  resolveEndpoint(tenantSiteId: string): Promise<TenantContext | null> {
    const mine = tenantSiteId === this.tenant.tenantSiteId;
    const live = this.siteEnabled && this.status === 'active';
    return Promise.resolve(mine && live ? this.tenant : null);
  }

  /**
   * The double answers for one slug, `test-tenant` by default.
   *
   * Overridable so an admin test can drive a second, unknown slug without a
   * second store; cross-tenant isolation itself is row-level security's job and
   * is covered against real Postgres.
   */
  resolveSlug(slug: string): Promise<{ tenantId: string } | null> {
    return Promise.resolve(slug === this.slug ? { tenantId: this.tenant.tenantId } : null);
  }

  resolveDomain(
    domain: string,
  ): Promise<{ tenantId: string; slug: string; active: boolean } | null> {
    return Promise.resolve(
      this.domains.has(domain)
        ? { tenantId: this.tenant.tenantId, slug: this.slug, active: this.status === 'active' }
        : null,
    );
  }

  claimDomain(domain: string): Promise<boolean> {
    if (this.domains.has(domain)) return Promise.resolve(false);
    this.domains.add(domain);
    return Promise.resolve(true);
  }

  admin(tenantId: string): AdminStore {
    if (tenantId !== this.tenant.tenantId) {
      throw new Error('InMemoryStore serves one tenant; use PostgresStore for more than one');
    }
    return new InMemoryAdminStore(this);
  }

  readonly pendingOrgSignups = new Map<string, PendingOrgSignup>();

  putPendingOrgSignup(signup: PendingOrgSignup): Promise<void> {
    this.pendingOrgSignups.set(signup.state, signup);
    return Promise.resolve();
  }

  takePendingOrgSignup(state: string): Promise<PendingOrgSignup | null> {
    const found = this.pendingOrgSignups.get(state) ?? null;
    this.pendingOrgSignups.delete(state);
    return Promise.resolve(found);
  }

  /**
   * Onboarding links, keyed by hash.
   *
   * Mutable, and typed as the platform console's richer row, so a test can point
   * this at `InMemoryPlatformStore`'s map and have both doubles see one set of
   * tokens. In a real deployment they are one table reached by two database roles —
   * the platform role inserts, this one reads and spends — and two unlinked maps
   * would let a test pass while the halves could never see each other's rows.
   */
  onboardingTokens = new Map<string, OnboardingTokenSummary>();

  findOnboardingToken(tokenHash: string): Promise<OnboardingToken | null> {
    return Promise.resolve(this.onboardingTokens.get(tokenHash) ?? null);
  }

  recordOnboardingAttempt(tokenHash: string): Promise<void> {
    const token = this.onboardingTokens.get(tokenHash);
    if (token !== undefined) {
      this.onboardingTokens.set(tokenHash, { ...token, attempts: token.attempts + 1 });
    }
    return Promise.resolve();
  }

  redeemOnboardingToken(tokenHash: string, at: string): Promise<OnboardingToken | null> {
    const token = this.onboardingTokens.get(tokenHash);

    if (
      token === undefined ||
      token.redeemedAt !== null ||
      token.revokedAt !== null ||
      Date.parse(token.expiresAt) <= Date.parse(at)
    ) {
      return Promise.resolve(null);
    }

    const redeemed = { ...token, redeemedAt: at };
    this.onboardingTokens.set(tokenHash, redeemed);
    return Promise.resolve(redeemed);
  }

  /** Likewise: its own site claim, or nothing. */
  resolveSiteClaim(cloudId: string, atlassianClientId: string): Promise<TenantContext | null> {
    const mine =
      cloudId === this.tenant.cloudId && atlassianClientId === this.tenant.atlassianClientId;
    return Promise.resolve(mine ? this.tenant : null);
  }

  forTenant(tenant: TenantContext): GatewayStore {
    if (tenant.tenantSiteId !== this.tenant.tenantSiteId) {
      // Refusing beats returning a store that shares this one's maps: a double
      // that silently ignored the tenant would make cross-tenant tests pass
      // while proving nothing.
      throw new Error('InMemoryStore serves one tenant; use PostgresStore for more than one');
    }
    return this;
  }

  createClient(client: OAuthClient): Promise<void> {
    this.clients.set(client.clientId, client);
    return Promise.resolve();
  }

  findClient(clientId: string): Promise<OAuthClient | null> {
    return Promise.resolve(this.clients.get(clientId) ?? null);
  }

  putPendingAuthorization(pending: PendingAuthorization): Promise<void> {
    this.pending.set(pending.brokerState, pending);
    return Promise.resolve();
  }

  takePendingAuthorization(brokerState: string): Promise<PendingAuthorization | null> {
    const found = this.pending.get(brokerState) ?? null;
    this.pending.delete(brokerState);
    return Promise.resolve(found);
  }

  putAuthorizationCode(code: AuthorizationCode): Promise<void> {
    this.codes.set(code.codeHash, code);
    return Promise.resolve();
  }

  redeemAuthorizationCode(codeHash: string, sessionId: string): Promise<AuthorizationCode | null> {
    const found = this.codes.get(codeHash);
    if (!found) {
      return Promise.resolve(null);
    }
    // Return the pre-update row so the caller can detect a replay.
    this.codes.set(codeHash, { ...found, redeemedSessionId: found.redeemedSessionId ?? sessionId });
    return Promise.resolve(found);
  }

  upsertUser(accountId: string, displayName: string): Promise<void> {
    this.users.set(accountId, displayName);
    return Promise.resolve();
  }

  putGrant(grant: Grant): Promise<void> {
    this.grants.set(grant.accountId, grant);
    return Promise.resolve();
  }

  getGrant(accountId: string): Promise<Grant | null> {
    return Promise.resolve(this.grants.get(accountId) ?? null);
  }

  deleteGrant(accountId: string): Promise<void> {
    this.grants.delete(accountId);
    return Promise.resolve();
  }

  createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  findSessionById(id: string): Promise<Session | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  findSessionByAccessToken(hash: string): Promise<Session | null> {
    return Promise.resolve(
      [...this.sessions.values()].find((s) => s.accessTokenHash === hash) ?? null,
    );
  }

  findSessionByRefreshToken(hash: string): Promise<Session | null> {
    return Promise.resolve(
      [...this.sessions.values()].find((s) => s.refreshTokenHash === hash) ?? null,
    );
  }

  rotateSession(id: string, rotation: SessionRotation): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, {
        ...session,
        accessTokenHash: rotation.accessTokenHash,
        refreshTokenHash: rotation.refreshTokenHash,
        accessTokenExpiresAt: rotation.accessTokenExpiresAt,
        refreshTokenExpiresAt: rotation.refreshTokenExpiresAt,
        lastSeenAt: rotation.at,
      });
    }
    return Promise.resolve();
  }

  touchSession(id: string, at: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, { ...session, lastSeenAt: at });
    }
    return Promise.resolve();
  }

  revokeSession(id: string, at: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, { ...session, revokedAt: at });
    }
    return Promise.resolve();
  }

  revokeSessionsForAccount(accountId: string, at: string): Promise<number> {
    let revoked = 0;
    for (const [id, session] of this.sessions) {
      if (session.accountId === accountId && session.revokedAt === null) {
        this.sessions.set(id, { ...session, revokedAt: at });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  listSessionsForSite(accountId: string): Promise<SessionSummary[]> {
    const summaries = [...this.sessions.values()]
      .filter(
        (session) =>
          session.accountId === accountId && session.tenantSiteId === this.tenant.tenantSiteId,
      )
      .map((session) => ({
        id: session.id,
        clientName: this.clients.get(session.clientId)?.clientName ?? session.clientId,
        // The double does not record a creation time, and last-seen starts equal
        // to it on a fresh session, which is close enough for a test double.
        createdAt: session.lastSeenAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.refreshTokenExpiresAt,
        revokedAt: session.revokedAt,
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

    return Promise.resolve(summaries);
  }

  revokeSessionsForSite(accountId: string, at: string): Promise<number> {
    let revoked = 0;
    for (const [id, session] of this.sessions) {
      if (
        session.accountId === accountId &&
        session.tenantSiteId === this.tenant.tenantSiteId &&
        session.revokedAt === null
      ) {
        this.sessions.set(id, { ...session, revokedAt: at });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  createReauthState(sessionId: string, expiresAt: string): Promise<string> {
    const state = generateSecret('');
    const stateHash = hashToken(state);
    this.reauthStates.set(stateHash, {
      stateHash,
      sessionId,
      expiresAt,
      usedAt: null,
    });
    return Promise.resolve(state);
  }

  consumeReauthState(state: string): Promise<string | null> {
    const stateHash = hashToken(state);
    const entry = this.reauthStates.get(stateHash);

    if (!entry || entry.usedAt !== null) {
      return Promise.resolve(null);
    }

    if (Date.parse(entry.expiresAt) <= Date.now()) {
      return Promise.resolve(null);
    }

    this.reauthStates.set(stateHash, { ...entry, usedAt: new Date().toISOString() });
    return Promise.resolve(entry.sessionId);
  }

  createPortalSession(session: PortalSession): Promise<void> {
    this.portalSessions.set(session.id, session);
    return Promise.resolve();
  }

  findPortalSession(tokenHash: string): Promise<PortalSession | null> {
    return Promise.resolve(
      [...this.portalSessions.values()].find((session) => session.tokenHash === tokenHash) ?? null,
    );
  }

  touchPortalSession(id: string, at: string): Promise<void> {
    const session = this.portalSessions.get(id);
    if (session) {
      this.portalSessions.set(id, { ...session, lastSeenAt: at });
    }
    return Promise.resolve();
  }

  revokePortalSession(id: string, at: string): Promise<void> {
    const session = this.portalSessions.get(id);
    if (session && session.revokedAt === null) {
      this.portalSessions.set(id, { ...session, revokedAt: at });
    }
    return Promise.resolve();
  }

  listPlaybooks(): Promise<PlaybookSummary[]> {
    const summaries = [...this.playbooks.values()]
      .map(({ id, slug, title, enabled, updatedAt }) => ({ id, slug, title, enabled, updatedAt }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return Promise.resolve(summaries);
  }

  getPlaybook(slug: string): Promise<Playbook | null> {
    return Promise.resolve([...this.playbooks.values()].find((p) => p.slug === slug) ?? null);
  }

  putPlaybook(input: PlaybookInput): Promise<void> {
    const at = new Date().toISOString();
    const existing = [...this.playbooks.values()].find((p) => p.slug === input.slug);
    const id = existing?.id ?? `playbook-${input.slug}`;
    this.playbooks.set(id, {
      id,
      slug: input.slug,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      enabled: existing?.enabled ?? true,
      updatedAt: at,
    });
    return Promise.resolve();
  }

  deletePlaybook(slug: string): Promise<void> {
    const existing = [...this.playbooks.entries()].find(([, p]) => p.slug === slug);
    if (existing) this.playbooks.delete(existing[0]);
    return Promise.resolve();
  }

  setPlaybookEnabled(slug: string, enabled: boolean): Promise<void> {
    const existing = [...this.playbooks.entries()].find(([, p]) => p.slug === slug);
    if (existing) {
      const [id, playbook] = existing;
      this.playbooks.set(id, { ...playbook, enabled, updatedAt: new Date().toISOString() });
    }
    return Promise.resolve();
  }

  writeAuditEvent(event: AuditEvent): Promise<void> {
    this.audit.push(event);
    return Promise.resolve();
  }

  /**
   * Kept readable here, unlike in Postgres where the application role holds
   * INSERT and nothing else. A test double that could not be inspected would
   * make "was this recorded" untestable, and the confidentiality property being
   * imitated is a grant, not application logic.
   */
  writePlatformAuditEvent(event: PlatformAuditEvent): Promise<void> {
    this.platformAudit.push(event);
    return Promise.resolve();
  }

  purgeExpired(now: string): Promise<void> {
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= now) this.pending.delete(key);
    }
    for (const [key, value] of this.codes) {
      if (value.expiresAt <= now) this.codes.delete(key);
    }
    for (const [key, value] of this.sessions) {
      if (value.refreshTokenExpiresAt <= now) this.sessions.delete(key);
    }
    for (const [key, value] of this.portalSessions) {
      if (value.expiresAt <= now) this.portalSessions.delete(key);
    }
    for (const [key, value] of this.pendingOrgSignups) {
      if (value.expiresAt <= now) this.pendingOrgSignups.delete(key);
    }
    /**
     * Compared as a number, not as a string, unlike everything above it.
     *
     * `DeviceAuthorizationRecord.expiresAt` is epoch milliseconds while every
     * other record here holds an ISO string, so the lexicographic comparison the
     * rest of this method relies on would be meaningless. Included at all because
     * a double that quietly kept rows the real store collects is how a leak gets
     * missed — each of these holds an operator's `id_token`.
     */
    const cutoff = Date.parse(now);
    for (const [key, value] of this.deviceAuthorizations) {
      if (value.expiresAt <= cutoff) this.deviceAuthorizations.delete(key);
    }
    return Promise.resolve();
  }

  readonly deviceAuthorizations = new Map<string, DeviceAuthorizationRecord>();

  saveDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void> {
    this.deviceAuthorizations.set(record.deviceCode, record);
    return Promise.resolve();
  }

  getDeviceAuthorization(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    return Promise.resolve(this.deviceAuthorizations.get(deviceCode) ?? null);
  }

  getDeviceAuthorizationByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    for (const record of this.deviceAuthorizations.values()) {
      if (record.userCode === userCode) return Promise.resolve(record);
    }
    return Promise.resolve(null);
  }

  getDeviceAuthorizationByApprovalToken(
    approvalToken: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    for (const record of this.deviceAuthorizations.values()) {
      if (record.approvalToken === approvalToken) return Promise.resolve(record);
    }
    return Promise.resolve(null);
  }

  deleteDeviceAuthorization(deviceCode: string): Promise<void> {
    this.deviceAuthorizations.delete(deviceCode);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The console's half of the double, over the same maps.
 *
 * It lives here rather than beside the interface because it shares
 * `InMemoryStore`'s state: a session opened through the OAuth flow has to appear
 * on the console's session list, and two doubles with two sets of maps would
 * agree with each other about nothing.
 */
export class InMemoryAdminStore implements AdminStore {
  readonly #store: InMemoryStore;

  constructor(store: InMemoryStore) {
    this.#store = store;
  }

  get tenantId(): string {
    return this.#store.tenant.tenantId;
  }

  getTenant(): Promise<TenantSummary | null> {
    return Promise.resolve({
      id: this.#store.tenant.tenantId,
      slug: this.#store.slug,
      name: this.#store.name,
      status: this.#store.status,
    });
  }

  getOidc(): Promise<TenantOidc | null> {
    return Promise.resolve(this.#store.oidc);
  }

  putOidc(oidc: TenantOidc): Promise<void> {
    this.#store.oidc = oidc;
    return Promise.resolve();
  }

  claimDomain(domain: string): Promise<boolean> {
    return this.#store.claimDomain(domain);
  }

  revokeAllOperatorSessions(at: string): Promise<void> {
    for (const [id, session] of this.#store.operatorSessions) {
      if (session.revokedAt === null) {
        this.#store.operatorSessions.set(id, { ...session, revokedAt: at });
      }
    }
    return Promise.resolve();
  }

  putOperatorAuthorization(pending: OperatorAuthorization): Promise<void> {
    this.#store.operatorAuthorizations.set(pending.state, pending);
    return Promise.resolve();
  }

  takeOperatorAuthorization(state: string): Promise<OperatorAuthorization | null> {
    const found = this.#store.operatorAuthorizations.get(state) ?? null;
    this.#store.operatorAuthorizations.delete(state);
    return Promise.resolve(found);
  }

  createOperatorSession(session: OperatorSession): Promise<void> {
    this.#store.operatorSessions.set(session.id, session);
    return Promise.resolve();
  }

  findOperatorSession(tokenHash: string): Promise<OperatorSession | null> {
    return Promise.resolve(
      [...this.#store.operatorSessions.values()].find(
        (session) => session.tokenHash === tokenHash,
      ) ?? null,
    );
  }

  touchOperatorSession(id: string, at: string): Promise<void> {
    const session = this.#store.operatorSessions.get(id);
    if (session) {
      this.#store.operatorSessions.set(id, { ...session, lastSeenAt: at });
    }
    return Promise.resolve();
  }

  revokeOperatorSession(id: string, at: string): Promise<void> {
    const session = this.#store.operatorSessions.get(id);
    if (session && session.revokedAt === null) {
      this.#store.operatorSessions.set(id, { ...session, revokedAt: at });
    }
    return Promise.resolve();
  }

  purgeExpired(now: string): Promise<void> {
    for (const [key, value] of this.#store.operatorAuthorizations) {
      if (value.expiresAt <= now) this.#store.operatorAuthorizations.delete(key);
    }
    for (const [key, value] of this.#store.operatorSessions) {
      if (value.expiresAt <= now) this.#store.operatorSessions.delete(key);
    }
    return Promise.resolve();
  }

  listSites(): Promise<AdminSite[]> {
    const store = this.#store;
    return Promise.resolve([
      {
        id: store.tenant.tenantSiteId,
        cloudId: store.tenant.cloudId,
        jiraUrl: null,
        siteUrl: [...store.grants.values()][0]?.siteUrl ?? null,
        atlassianClientId: store.tenant.atlassianClientId,
        enabled: store.siteEnabled,
        createdAt: new Date().toISOString(),
        linkedUsers: store.links.size,
      },
    ]);
  }

  setSiteEnabled(tenantSiteId: string, enabled: boolean): Promise<void> {
    if (tenantSiteId === this.#store.tenant.tenantSiteId) {
      this.#store.siteEnabled = enabled;
    }
    return Promise.resolve();
  }

  claimSite(input: {
    cloudId: string;
    jiraUrl?: string;
    siteUrl?: string;
  }): Promise<{ outcome: 'claimed'; site: AdminSite } | { outcome: 'conflict' }> {
    const store = this.#store;

    // The double's one site already occupies (cloud_id, atlassian_client_id)
    // for its own cloud ID — the same conflict `ON CONFLICT DO NOTHING` would
    // report in production.
    if (input.cloudId === store.tenant.cloudId) {
      return Promise.resolve({ outcome: 'conflict' });
    }

    // A second site is otherwise accepted here for route-level tests, but not
    // reflected in listSites(): the double models one tenant and one site by
    // construction (see the class doc), and multi-site behavior is covered
    // against real Postgres in test/gateway/postgres-admin-store.test.ts.
    return Promise.resolve({
      outcome: 'claimed',
      site: {
        id: `site-${input.cloudId}`,
        cloudId: input.cloudId,
        jiraUrl: input.jiraUrl ?? null,
        siteUrl: input.siteUrl ?? null,
        atlassianClientId: store.tenant.atlassianClientId,
        enabled: true,
        createdAt: new Date().toISOString(),
        linkedUsers: 0,
      },
    });
  }

  listUsers(): Promise<AdminUser[]> {
    const store = this.#store;
    const users = [...store.links.keys()].map((accountId) => ({
      accountId,
      displayName: store.users.get(accountId) ?? accountId,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      liveSessions: [...store.sessions.values()].filter(
        (session) => session.accountId === accountId && session.revokedAt === null,
      ).length,
      hasGrant: store.grants.has(accountId),
    }));

    return Promise.resolve(users);
  }

  listSessions(accountId?: string): Promise<AdminSession[]> {
    const store = this.#store;
    const sessions = [...store.sessions.values()]
      .filter((session) => accountId === undefined || session.accountId === accountId)
      .map((session) => ({
        id: session.id,
        accountId: session.accountId,
        displayName: store.users.get(session.accountId) ?? session.accountId,
        clientName: store.clients.get(session.clientId)?.clientName ?? session.clientId,
        tenantSiteId: session.tenantSiteId,
        // The double models one site with no resolved Jira URL of its own;
        // multi-site display is covered against real Postgres.
        siteJiraUrl: null,
        siteCloudId: store.tenant.cloudId,
        scope: session.scope,
        createdAt: session.lastSeenAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.refreshTokenExpiresAt,
        revokedAt: session.revokedAt,
      }));

    return Promise.resolve(sessions);
  }

  revokeSession(sessionId: string, at: string): Promise<number> {
    const session = this.#store.sessions.get(sessionId);
    if (!session || session.revokedAt !== null) return Promise.resolve(0);

    this.#store.sessions.set(sessionId, { ...session, revokedAt: at });
    return Promise.resolve(1);
  }

  revokeSessionsForAccount(accountId: string, at: string): Promise<number> {
    return this.#store.revokeSessionsForAccount(accountId, at);
  }

  deleteGrantsForAccount(accountId: string): Promise<number> {
    const had = this.#store.grants.delete(accountId);
    return Promise.resolve(had ? 1 : 0);
  }

  readAuditLog(options: { limit: number; before?: string }): Promise<AdminAuditRow[]> {
    const store = this.#store;
    const rows = store.audit
      .map((event, index) => ({
        id: String(index + 1),
        occurredAt: event.timestamp,
        accountId: event.userAccountId,
        displayName: store.users.get(event.userAccountId) ?? null,
        tool: event.tool,
        issueKeys: event.issueKeys,
        outcome: event.outcome,
        cloudId: store.tenant.cloudId,
      }))
      .filter((row) => options.before === undefined || row.occurredAt < options.before)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, options.limit);

    return Promise.resolve(rows);
  }

  getKeyMetadata(): Promise<TenantKeyMetadata> {
    const { source, kmsProvider, kmsKeyRef, updatedAt } = this.#store.tenantKey;
    return Promise.resolve({ source, kmsProvider, kmsKeyRef, updatedAt });
  }

  setLiteralKey(wrappedKey: string): Promise<void> {
    this.#store.tenantKey = {
      source: 'literal',
      kmsProvider: null,
      kmsKeyRef: null,
      updatedAt: new Date().toISOString(),
      wrappedKey,
    };
    return Promise.resolve();
  }

  useDeploymentKey(): Promise<void> {
    this.#store.tenantKey = {
      source: 'deployment',
      kmsProvider: null,
      kmsKeyRef: null,
      updatedAt: new Date().toISOString(),
      wrappedKey: null,
    };
    return Promise.resolve();
  }

  // Delegates to the shared store: a playbook authored through the console
  // must be the same row `list_playbooks`/`get_playbook` see on the MCP path,
  // and this double backs both interfaces with one set of maps.
  listPlaybooks(): Promise<PlaybookSummary[]> {
    return this.#store.listPlaybooks();
  }

  getPlaybook(slug: string): Promise<Playbook | null> {
    return this.#store.getPlaybook(slug);
  }

  putPlaybook(input: PlaybookInput): Promise<void> {
    return this.#store.putPlaybook(input);
  }

  deletePlaybook(slug: string): Promise<void> {
    return this.#store.deletePlaybook(slug);
  }

  setPlaybookEnabled(slug: string, enabled: boolean): Promise<void> {
    return this.#store.setPlaybookEnabled(slug, enabled);
  }
}
