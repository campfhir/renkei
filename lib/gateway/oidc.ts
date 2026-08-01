/**
 * The tenant's own identity provider, for operator sign-in only.
 *
 * **OIDC, never SAML.** Not a preference: verifying XML signatures is where
 * signature wrapping and canonicalization have broken most implementations, and
 * Entra, Google, and Okta all speak OIDC regardless. Choosing the protocol whose
 * verification is a detached JWS over a canonical string, rather than over a
 * tree a parser can be talked into reading two ways, removes a class of bug
 * rather than mitigating it.
 *
 * **The signature check is `jose`, deliberately not hand-rolled.** Node's crypto
 * can verify an RS256 JWS in about forty lines, and the forty lines are not the
 * risk — the risk is the checks around them, which is where every JWT
 * vulnerability of the last decade has lived: `alg: none`, algorithm confusion
 * that verifies an HS256 MAC against the public key as its secret, `kid`
 * pointing somewhere attacker-controlled, and claims nobody checked. Having
 * argued above for the protocol with fewer places to get verification wrong, it
 * would be strange to then write the verification here. `jose` is the reference
 * implementation, has no dependencies of its own, and refuses the confusion
 * cases by construction when given an algorithm allowlist.
 *
 * What is *not* delegated is the fetching. Discovery and JWKS go through the
 * injected `fetchImpl`, so the whole flow is drivable in a test against a locally
 * generated key pair with no network at all, and so the caching policy is
 * visible here rather than inside a library.
 */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { FetchLike } from '../auth/atlassian.js';

/**
 * Asymmetric only, and enumerated rather than "not HS*".
 *
 * An allowlist is what makes algorithm confusion impossible instead of
 * unlikely: with `HS256` absent, a token signed with a MAC over the public key
 * cannot verify no matter what its header claims, and `none` is not a value any
 * branch here accepts.
 */
export const ALLOWED_ID_TOKEN_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

/** Enough clock skew to survive a badly-synchronized IdP, not enough to matter. */
const CLOCK_TOLERANCE_SECONDS = 30;

/** Discovery and JWKS cache TTL. Reduced from 10 min to 2 min for faster credential changes. */
const CACHE_TTL_MS = 2 * 60 * 1000;

/**
 * The floor between JWKS refetches triggered by an unknown `kid`.
 *
 * Without it, a stream of tokens carrying invented `kid`s is a request
 * amplifier pointed at the tenant's IdP, with Renkei as the amplifier.
 */
const JWKS_REFETCH_FLOOR_MS = 60 * 1000;

/** A tenant's IdP registration, from `tenant_oidc`. */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Which claim carries role membership. */
  roleClaim: string;
  /** Null means any subject the IdP authenticates is an operator. */
  requiredRole: string | null;
}

/** The subset of the discovery document this needs. */
export interface OidcProvider {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  tokenAuthMethods: string[];
}

/** Who signed in, once the id_token has been verified and authorized. */
export interface OperatorIdentity {
  subject: string;
  /** A name or email claim. Display only. */
  displayName: string | null;
  /** Present when the provider returned an `email` claim; null otherwise. */
  email: string | null;
  /**
   * The provider's own `email_verified` claim. `null` means the claim was
   * absent, which is common for enterprise IdPs (Okta, Entra) whose
   * organization-issued email is implicitly verified rather than asserted
   * per-token. A caller doing domain proof (the self-service wizard) should
   * treat `null` as acceptable and `false` as a hard refusal.
   */
  emailVerified: boolean | null;
}

/**
 * A failure with something a human can act on.
 *
 * `detail` is shown in the browser and is deliberately specific: an operator
 * console that cannot be signed into is a configuration problem, and "sign-in
 * failed" would leave the tenant's administrator guessing between six causes.
 * Nothing in it echoes a token or a secret.
 */
export class OidcError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'OidcError';
    this.detail = detail;
  }
}

interface Cached<T> {
  value: T;
  fetchedAt: number;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * An issuer must be https, except on loopback.
 *
 * The same rule the OAuth redirect URIs follow, for the same reason: plain HTTP
 * to an IdP is a sign-in an on-path attacker can rewrite, and loopback is the
 * one case where there is no path to be on.
 */
function assertUsableIssuer(issuer: string): URL {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new OidcError('issuer is not a URL', 'This tenant’s configured issuer is not a URL.');
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  if (url.protocol !== 'https:' && !loopback) {
    throw new OidcError(
      'issuer is not https',
      'This tenant’s issuer is not an https URL. Sign-in over plain HTTP can be rewritten in ' +
        'transit, so it is refused.',
    );
  }

  return url;
}

export interface OidcClientOptions {
  fetchImpl: FetchLike;
  now: () => Date;
}

export class OidcClient {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #providers = new Map<string, Cached<OidcProvider>>();
  readonly #jwks = new Map<string, Cached<JSONWebKeySet>>();

  constructor(options: OidcClientOptions) {
    this.#fetch = options.fetchImpl;
    this.#now = options.now;
  }

  /**
   * Invalidate cached discovery and JWKS for an issuer. Call this when the
   * tenant's OIDC configuration changes (issuer, client ID, client secret) so
   * stale endpoints and keys are not used until TTL expiry.
   */
  invalidateCache(issuer: string): void {
    this.#providers.delete(issuer);
    // Also invalidate JWKS for this issuer, since the discovery doc is likely
    // to change and old keys may become invalid.
    for (const [jwksUri] of this.#jwks.entries()) {
      // Only invalidate if it's from this issuer's well-known path (heuristic)
      if (jwksUri.includes(issuer.replace(/\/+$/, ''))) {
        this.#jwks.delete(jwksUri);
      }
    }
  }

  /**
   * The discovery document, cached per issuer.
   *
   * The `issuer` inside the document is checked against the one configured, per
   * OIDC Discovery §4.3. Skipping it would mean a document served at one
   * issuer's well-known path could name another's endpoints, which is a sign-in
   * redirected to an IdP the tenant did not choose.
   */
  async discover(issuer: string): Promise<OidcProvider> {
    const url = assertUsableIssuer(issuer);
    const cached = this.#providers.get(issuer);

    if (cached !== undefined && this.#now().getTime() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }

    // Appended rather than resolved with `new URL(path, base)`: an issuer with a
    // path component is legal, and resolving would drop it.
    const document = await this.#getJson(
      `${url.toString().replace(/\/+$/, '')}/.well-known/openid-configuration`,
      'the discovery document',
    );

    const found = document as Record<string, unknown>;
    const provider: OidcProvider = {
      issuer: asString(found.issuer) ?? '',
      authorizationEndpoint: asString(found.authorization_endpoint) ?? '',
      tokenEndpoint: asString(found.token_endpoint) ?? '',
      jwksUri: asString(found.jwks_uri) ?? '',
      tokenAuthMethods: Array.isArray(found.token_endpoint_auth_methods_supported)
        ? found.token_endpoint_auth_methods_supported.map(String)
        : [],
    };

    if (provider.issuer !== issuer) {
      throw new OidcError(
        'discovery issuer mismatch',
        `The identity provider at ${issuer} describes itself as ${provider.issuer || 'nothing'}. ` +
          'The configured issuer has to match the document exactly.',
      );
    }
    if (
      provider.authorizationEndpoint === '' ||
      provider.tokenEndpoint === '' ||
      provider.jwksUri === ''
    ) {
      throw new OidcError(
        'discovery document incomplete',
        'The identity provider’s discovery document is missing an authorization endpoint, token ' +
          'endpoint, or JWKS URI.',
      );
    }

    this.#providers.set(issuer, { value: provider, fetchedAt: this.#now().getTime() });
    return provider;
  }

  /**
   * Where to send the browser.
   *
   * `prompt` is left alone: whether to force re-authentication is the tenant
   * IdP's policy to make, and an operator console that re-prompted on every
   * sign-in would train people to type a password more often than they need to.
   */
  buildAuthorizeUrl(
    provider: OidcProvider,
    config: OidcConfig,
    params: { state: string; nonce: string; codeChallenge: string; redirectUri: string },
  ): string {
    const url = new URL(provider.authorizationEndpoint);

    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    // S256 only, on this leg as much as on Renkei's own: `plain` would let a
    // network observer who saw the challenge complete the exchange.
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  /**
   * Redeems the code for an id_token.
   *
   * Only the id_token is used. No userinfo call, no access token kept: the one
   * question being asked is who this is and whether they are an operator, and
   * both answers are claims. Holding an IdP access token would be holding a
   * credential for something other than Renkei, which nothing here needs.
   */
  async exchangeCode(
    provider: OidcProvider,
    config: OidcConfig,
    params: { code: string; redirectUri: string; codeVerifier: string },
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      client_id: config.clientId,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };

    // Basic when the IdP advertises it, which is the spec's SHOULD; otherwise
    // the secret goes in the body, which every provider accepts and some
    // require. Both halves are form-encoded per RFC 6749 §2.3.1.
    if (provider.tokenAuthMethods.includes('client_secret_basic')) {
      const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    } else {
      body.set('client_secret', config.clientSecret);
    }

    const response = await this.#fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      // Invalidate discovery cache on token endpoint failure — it may be
      // stale, and the tenant may have just fixed their OIDC config.
      this.invalidateCache(provider.issuer);
      // Never echo the payload: it can contain the submitted client secret.
      throw new OidcError(
        `token endpoint returned ${response.status}`,
        "The identity provider refused the sign-in. If this deployment’s redirect URI or client " +
          "secret was changed recently, that is the first thing to check.",
      );
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const idToken = asString(payload.id_token);

    if (idToken === null) {
      throw new OidcError(
        'no id_token in the token response',
        'The identity provider returned no id_token. The client may be registered without the ' +
          '`openid` scope.',
      );
    }

    return idToken;
  }

  /**
   * Verifies the id_token and decides whether its subject is an operator.
   *
   * Signature against the IdP's JWKS by `kid`, `iss` and `aud` and `exp` by
   * `jose` against the values passed here, `alg` against the allowlist above,
   * and `nonce` against the row this flow started from. Authorization is then a
   * claim rather than a table, so removing somebody from the role in the IdP
   * ends their access here at their next sign-in without anyone touching
   * Renkei.
   */
  async verifyIdToken(
    provider: OidcProvider,
    config: OidcConfig,
    idToken: string,
    expectedNonce: string | null,
  ): Promise<OperatorIdentity> {
    const payload = await this.#verifySignature(provider, config, idToken);

    // Not checked by `jose`, and the one that makes a stolen id_token useless:
    // it has to belong to the flow this callback is completing.
    //
    // Refused with the *same* message as a bad signature or a wrong audience,
    // deliberately. A distinct one would tell whoever is probing that the
    // signature and audience checks passed and only this did — and the advice to
    // the person in the browser is identical either way.
    //
    // Only check if a nonce is expected (console flow). Device auth bypasses the
    // nonce check because the bearer token is already the proof of authorization.
    if (expectedNonce !== null && asString(payload.nonce) !== expectedNonce) {
      throw new OidcError('nonce mismatch', UNVERIFIABLE);
    }

    const subject = asString(payload.sub);
    if (subject === null) {
      throw new OidcError(
        'id_token has no subject',
        'The identity provider returned a token with no `sub` claim, so there is nobody to sign in.',
      );
    }

    if (config.requiredRole !== null && !this.#hasGroup(payload, config)) {
      // Invalidate on authz failure — the IdP may have just fixed the claim or role.
      this.invalidateCache(provider.issuer);
      throw new OidcError(
        'subject is not in the required role',
        `You signed in successfully, but your account is not in the role this tenant requires ` +
          `for operator access. Whoever administers ${config.issuer} can add it.`,
      );
    }

    return {
      subject,
      displayName:
        asString(payload.name) ?? asString(payload.email) ?? asString(payload.preferred_username),
      email: asString(payload.email),
      emailVerified: typeof payload.email_verified === 'boolean' ? payload.email_verified : null,
    };
  }

  async #verifySignature(
    provider: OidcProvider,
    config: OidcConfig,
    idToken: string,
  ): Promise<JWTPayload> {
    const verify = async (jwks: JSONWebKeySet): Promise<JWTPayload> => {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
        issuer: provider.issuer,
        // The audience is this tenant's client ID. A token minted for another
        // client of the same IdP is not a sign-in here.
        audience: config.clientId,
        algorithms: [...ALLOWED_ID_TOKEN_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return payload;
    };

    const cached = await this.#getJwks(provider.jwksUri, false);

    try {
      return await verify(cached);
    } catch (error) {
      // An unknown `kid` is the ordinary consequence of the IdP rotating keys,
      // so it earns exactly one refetch — rate-limited, because otherwise a
      // stream of invented `kid`s turns this into a request amplifier aimed at
      // the tenant's IdP.
      if (!isNoMatchingKey(error)) throw asOidcError(error);

      const refreshed = await this.#getJwks(provider.jwksUri, true);
      if (refreshed === cached) throw asOidcError(error);

      try {
        return await verify(refreshed);
      } catch (retried) {
        // Invalidate on persistent failure — config issue, not just key rotation.
        this.invalidateCache(provider.issuer);
        throw asOidcError(retried);
      }
    }
  }

  async #getJwks(jwksUri: string, force: boolean): Promise<JSONWebKeySet> {
    const cached = this.#jwks.get(jwksUri);
    const age = cached === undefined ? Infinity : this.#now().getTime() - cached.fetchedAt;

    if (cached !== undefined) {
      if (force ? age < JWKS_REFETCH_FLOOR_MS : age < CACHE_TTL_MS) {
        return cached.value;
      }
    }

    const document = (await this.#getJson(jwksUri, 'the signing keys')) as JSONWebKeySet;

    if (!Array.isArray(document.keys)) {
      throw new OidcError(
        'JWKS has no keys array',
        'The identity provider’s signing keys could not be read.',
      );
    }

    this.#jwks.set(jwksUri, { value: document, fetchedAt: this.#now().getTime() });
    return document;
  }

  /**
   * Role membership from the id_token, and only from the id_token.
   *
   * Some providers put groups in an access token or behind userinfo instead, and
   * supporting those would mean holding an IdP access token — see
   * `exchangeCode`. A tenant whose IdP does not emit the claim here configures
   * it to (Entra calls them optional claims) or leaves `required_role` null and
   * restricts the IdP application instead.
   */
  #hasGroup(payload: JWTPayload, config: OidcConfig): boolean {
    const claim = payload[config.roleClaim];
    const values = Array.isArray(claim) ? claim : [claim];

    return values.some((value) => typeof value === 'string' && value === config.requiredRole);
  }

  async #getJson(url: string, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, { headers: { accept: 'application/json' } });
    } catch {
      throw new OidcError(
        `could not reach ${url}`,
        `Renkei could not reach the identity provider to read ${what}.`,
      );
    }

    if (!response.ok) {
      throw new OidcError(
        `${url} returned ${response.status}`,
        `The identity provider returned ${response.status} for ${what}.`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new OidcError(`${url} was not JSON`, `The identity provider’s ${what} was not JSON.`);
    }
  }
}

function isNoMatchingKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_JWKS_NO_MATCHING_KEY'
  );
}

/**
 * The one thing said about a token that did not verify.
 *
 * A bad signature, an expired token, the wrong audience, and a replayed nonce are
 * all "that sign-in is not usable". Distinguishing them for the browser would
 * describe this deployment's checks to whoever is probing them, and the advice is
 * the same in every case. The specific reason goes to the log.
 */
const UNVERIFIABLE =
  'That sign-in could not be verified. Begin again; if it keeps failing, this tenant’s identity ' +
  'provider configuration needs checking.';

function asOidcError(error: unknown): OidcError {
  if (error instanceof OidcError) return error;

  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'unknown';

  return new OidcError(`id_token verification failed (${code})`, UNVERIFIABLE);
}
