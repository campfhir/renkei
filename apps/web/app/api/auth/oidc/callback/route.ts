import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getDataStore, actorFields, actorFrom, type ActorFields } from '@renkei/db';
import { getTenantOidc } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
  SESSION_TTL_SECONDS,
} from '@/lib/session';
import {
  identityClaimsFromIdToken,
  hasGroupsOverage,
  upsertIdentity,
  clearIdpGroups,
} from '@/lib/identity';
import { recordAuditEvent } from '@/lib/audit-events';
import { oidcDiscoveryUrl } from '@/lib/oidc-discovery';
import { safeFetch, assertPublicHttpsUrl, BlockedUrlError } from '@/lib/safe-fetch';
import { verifyIdTokenClaims } from '@/lib/oidc-id-token';
import { safeReturnPath } from '@/lib/return-path';

interface OIDCTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

interface DecodedToken {
  [key: string]: unknown;
}

function decodeJWT(token: string): DecodedToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // JWT segments are base64url, not base64: decoding as plain base64
    // mishandles the '-' and '_' characters.
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isOIDCTokenResponse(data: unknown): data is OIDCTokenResponse {
  if (typeof data !== 'object' || data === null) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.access_token === 'string' &&
    typeof obj.token_type === 'string' &&
    typeof obj.expires_in === 'number'
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const pendingSignins = getDataStore().pendingSignins;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.json({ error: `OIDC error: ${error}` }, { status: 400 });
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  // The person signing in, once the id_token names them — for every line
  // from then on, the catch-all included.
  let signingIn: ActorFields | null = null;
  try {
    // Look up pending OIDC state
    const pendingSignIn = await pendingSignins.findByState(state);

    if (!pendingSignIn) {
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 });
    }

    // Verify state is not expired
    if (pendingSignIn.expiresAt < new Date()) {
      await pendingSignins.deleteByState(state);
      return NextResponse.json({ error: 'State expired' }, { status: 400 });
    }

    // CSRF / session-fixation defense: the state must match the cookie the login
    // route set in THIS browser. A state+code pair captured elsewhere and
    // replayed into a victim's browser carries no matching cookie, so it is
    // rejected here before any session is minted. The cookie is cleared on the
    // response below regardless of outcome.
    const stateCookie = request.cookies.get('oidc_state')?.value;
    if (!stateCookie || stateCookie !== state) {
      await pendingSignins.deleteByState(state);
      logger.warn(
        'a sign-in callback arrived without the state cookie its login step set in the browser; rejected and the state consumed, so nobody was signed in',
        { component: 'auth/oidc' }
      );
      const response = NextResponse.json({ error: 'Invalid state' }, { status: 400 });
      response.cookies.delete('oidc_state');
      return response;
    }

    // Get OIDC config
    const oidcResult = await getTenantOidc();
    if (!oidcResult.ok) {
      logger.error(
        'a sign-in callback could not be served: the OIDC configuration could not be read; nobody was signed in: {error}',
        {
          component: 'auth/oidc',
          error: oidcResult.err.message ?? oidcResult.err.type,
        }
      );
      return NextResponse.json({ error: 'Failed to retrieve OIDC configuration' }, { status: 500 });
    }
    const oidc = oidcResult.val;
    if (!oidc) {
      return NextResponse.json({ error: 'OIDC not configured' }, { status: 400 });
    }

    // Fetch OIDC discovery document to get the token endpoint
    const discoveryUrl = oidcDiscoveryUrl(oidc.issuer);
    let tokenEndpoint: string;

    console.log(`[OIDC] Fetching discovery from: ${discoveryUrl}`);

    try {
      // SSRF-guarded like the login route: constrain the issuer-derived fetch
      // to a public https target.
      const discoveryResponse = await safeFetch(discoveryUrl);
      if (discoveryResponse.ok) {
        const discovery = await discoveryResponse.json();
        tokenEndpoint = discovery.token_endpoint;
        console.log(`[OIDC] Discovery successful, using token endpoint: ${tokenEndpoint}`);
      } else {
        console.log(
          `[OIDC] Discovery failed with status ${discoveryResponse.status}, using Azure AD fallback`
        );
        // For Azure AD specifically, use the OAuth2 v2.0 endpoint
        // Strip trailing /v2.0 from issuer if present to avoid duplication
        const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
        tokenEndpoint = `${baseIssuer}/oauth2/v2.0/token`;
      }
    } catch (error) {
      logger.warn(
        "a sign-in callback could not fetch the IdP's discovery document; falling back to the Azure AD v2.0 token endpoint: {error}",
        {
          component: 'auth/oidc',
          issuer: oidc.issuer,
          discoveryUrl,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      // Fallback to Azure AD OAuth2 v2.0 endpoint
      // Strip trailing /v2.0 from issuer if present to avoid duplication
      const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
      tokenEndpoint = `${baseIssuer}/oauth2/v2.0/token`;
    }

    // Exchange code for token
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      logger.error(
        'a sign-in callback could not resolve the app origin; nobody was signed in: {error}',
        {
          component: 'auth/oidc',
          error: originResult.err.message ?? originResult.err.type,
        }
      );
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const origin = originResult.val;

    // The token endpoint comes from the discovery document (or the issuer
    // fallback) and this request carries the client secret, so it is
    // SSRF-guarded too: the secret must not be POSTed to an internal address a
    // hostile discovery document named.
    try {
      await assertPublicHttpsUrl(tokenEndpoint);
    } catch (tokenUrlError) {
      if (tokenUrlError instanceof BlockedUrlError) {
        logger.error(
          "the IdP's token endpoint {tokenEndpoint} is not an allowed URL, so the sign-in code was not exchanged; nobody was signed in: {error}",
          {
            component: 'auth/oidc',
            tokenEndpoint,
            error: tokenUrlError.message,
          }
        );
        return NextResponse.json({ error: 'Invalid token endpoint' }, { status: 400 });
      }
      throw tokenUrlError;
    }

    // safeFetch, not fetch: a redirect from the token endpoint is re-checked
    // and the socket is dialled at the address the guard verified, so the
    // secret cannot be sent on to an internal host either way.
    let tokenResponse: Response;
    try {
      tokenResponse = await safeFetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: oidc.clientId,
          client_secret: oidc.clientSecret,
          code,
          redirect_uri: `${origin}/api/auth/oidc/callback`,
        }).toString(),
      });
    } catch (tokenFetchError) {
      if (tokenFetchError instanceof BlockedUrlError) {
        logger.error(
          "the IdP's token endpoint {tokenEndpoint} is not an allowed URL, so the sign-in code was not exchanged; nobody was signed in: {error}",
          {
            component: 'auth/oidc',
            tokenEndpoint,
            error: tokenFetchError.message,
          }
        );
        return NextResponse.json({ error: 'Invalid token endpoint' }, { status: 400 });
      }
      throw tokenFetchError;
    }

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.warn(
        'the IdP refused to exchange the sign-in code ({status}); nobody was signed in: {detail}',
        {
          component: 'auth/oidc',
          status: tokenResponse.status,
          tokenEndpoint,
          detail: errorText.slice(0, 500),
        }
      );
      return NextResponse.json({ error: 'Failed to exchange code for token' }, { status: 400 });
    }

    const tokenData = await tokenResponse.json();
    if (!isOIDCTokenResponse(tokenData)) {
      return NextResponse.json({ error: 'Invalid token response' }, { status: 400 });
    }

    // The id_token is the only trustworthy source of the user's identity here.
    // Without it we cannot say who this session belongs to, and a session with
    // no subject would put us back to acting as an arbitrary account.
    const decoded = tokenData.id_token ? decodeJWT(tokenData.id_token) : null;
    const subject = typeof decoded?.sub === 'string' ? decoded.sub : null;

    if (!subject) {
      logger.error(
        "the IdP's id_token carried no sub claim, so there is nobody to sign in; the browser saw an error",
        { component: 'auth/oidc' }
      );
      return NextResponse.json(
        { error: 'Identity provider did not return a subject claim' },
        { status: 400 }
      );
    }
    // Named from the claims as presented — the identity row does not exist
    // yet — so every line from here reads as a person, not a subject.
    signingIn = actorFields(
      actorFrom(
        subject,
        typeof decoded?.name === 'string' ? decoded.name : null,
        typeof decoded?.email === 'string' ? decoded.email : null
      )
    );
    const actor = signingIn;

    // Validate the id_token's claims. The token is fetched over the TLS
    // back-channel directly from the token endpoint, so signature verification
    // is defense-in-depth (RFC 8725 permits omitting it for back-channel
    // tokens); nonce, aud, iss, and exp are checked here because they catch
    // replay and token-substitution that the back-channel alone does not.
    const claimError = verifyIdTokenClaims(decoded, {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      nonce: pendingSignIn.nonce,
    });
    if (claimError) {
      await pendingSignins.deleteByState(state);
      logger.error("{actor}'s id_token failed claim validation ({reason}); nobody was signed in", {
        component: 'auth/oidc',
        ...actor,
        reason: claimError,
      });
      const response = NextResponse.json({ error: 'Invalid id_token' }, { status: 400 });
      response.cookies.delete('oidc_state');
      return response;
    }

    // Decode and mint standardized renkei roles from IDP claims
    const userRoles = new Set<string>();
    {
      if (decoded && oidc.roleClaim) {
        const idpClaim = decoded[oidc.roleClaim];

        // Handle both single value string and array of values
        const idpValues = Array.isArray(idpClaim) ? idpClaim : idpClaim ? [idpClaim] : [];

        for (const value of idpValues) {
          if (value === oidc.operatorIdpValue) {
            userRoles.add('renkei-operator');
          }
          if (value === oidc.userIdpValue) {
            userRoles.add('renkei-user');
          }
        }

        // Require user to have at least one renkei role
        if (userRoles.size === 0) {
          logger.warn(
            '{actor} was refused sign-in: no authorized role in IdP claim {roleClaim} ({claim})',
            {
              component: 'auth/oidc',
              ...actor,
              roleClaim: oidc.roleClaim,
              claim: JSON.stringify(idpClaim),
            }
          );
          return NextResponse.json({ error: 'User role not authorized' }, { status: 403 });
        }
      }
    }

    // Recorded only now, after the role check: a sign-in refused above
    // leaves no identity behind for an email lookup to find.
    // Record the identity spine entry (subject → email, plus the groups
    // claim for connector audiences) while the id_token is in hand — the
    // only moment the mapping is trustworthy. Non-fatal: a failed upsert
    // must not break sign-in, and everything downstream that needs the
    // email fails closed without it. No extra scope is requested for
    // groups: it is not a standard OIDC scope, and IdPs emit the claim per
    // app registration (Entra) or claim mapping (Okta, Keycloak).
    //
    // Groups are never assumed. With no groups claim configured the person
    // is in no groups; a token that omits the configured claim puts them
    // in none; and a token whose claims cannot be read forgets the groups
    // recorded at their last sign-in. An audience-scoped connector is open
    // only to someone whose current token names one of its groups.
    const groupsClaim = oidc.groupsClaim || null;
    const identityClaims = decoded ? identityClaimsFromIdToken(decoded, groupsClaim) : null;
    if (decoded && groupsClaim && hasGroupsOverage(decoded, groupsClaim)) {
      // Entra omits the claim past ~200 groups and points at Graph instead.
      // Renkei does not follow the pointer, so this person has no groups on
      // record and every audience-scoped connector is closed to them.
      logger.warn(
        '{actor} is signing in with an id_token that omits the groups claim (groups overage); they are recorded in no groups and audience rules fail closed for them',
        { component: 'auth/oidc', ...actor, groupsClaim }
      );
    }
    if (identityClaims) {
      const recorded = await upsertIdentity(subject, identityClaims);
      if (!recorded.ok) {
        logger.warn(
          '{actor} is signing in, but their identity (email, groups) could not be recorded; gates will fail closed for them: {error}',
          {
            component: 'auth/oidc',
            ...actor,
            error: recorded.err.message ?? recorded.err.type,
          }
        );
      }
    } else {
      logger.warn(
        '{actor} is signing in with an id_token that carries no email claim; gates will fail closed for them',
        {
          component: 'auth/oidc',
          ...actor,
        }
      );
      const forgotten = await clearIdpGroups(subject);
      if (!forgotten.ok) {
        logger.warn(
          "{actor}'s recorded groups could not be cleared after an id_token without readable claims; groups from their last sign-in may remain",
          {
            component: 'auth/oidc',
            ...actor,
          }
        );
      }
    }

    // Delete used state token
    await pendingSignins.deleteByState(state);

    // Get redirect target from cookie; without one, land on the home page.
    const redirect = safeReturnPath(request.cookies.get('oidc_redirect')?.value) ?? '/';

    // Create a server-side session. Subject and roles are stored in the database
    // and never sent to the client; the cookie holds only an opaque id. Previously
    // roles rode in a non-httpOnly unsigned cookie, which anyone could rewrite.
    //
    // The session's lifetime is SESSION_TTL_SECONDS, not the IdP access token's
    // `expires_in` — that token is never used again after this exchange, and
    // tying our own session to its (often hour-long) lifetime made every
    // sign-in expire far sooner than anyone signing in expects.
    const sessionResult = await createSession(subject, Array.from(userRoles), SESSION_TTL_SECONDS);
    if (!sessionResult.ok) {
      logger.error(
        '{actor} could not be signed in: no session was created, and they saw "Failed to establish session": {error}',
        {
          component: 'auth/oidc',
          ...actor,
          error: sessionResult.err.message ?? sessionResult.err.type,
        }
      );
      return NextResponse.json({ error: 'Failed to establish session' }, { status: 500 });
    }
    recordAuditEvent({ actorSubject: subject, action: 'user.signed_in' });

    logger.info('{actor} finished signing in through {issuer}; sent to {redirect}', {
      component: 'auth/oidc',
      ...actor,
      issuer: oidc.issuer,
      roles: Array.from(userRoles),
      redirect,
    });

    const response = NextResponse.redirect(new URL(redirect, origin));
    response.cookies.set(
      sessionCookieName(),
      sessionResult.val.id,
      sessionCookieOptions(SESSION_TTL_SECONDS)
    );

    // Retire the forgeable cookies from the previous scheme.
    response.cookies.delete('oidc_token');
    response.cookies.delete('oidc_roles');
    response.cookies.delete('oidc_redirect');
    // The one-time CSRF binding cookie has done its job.
    response.cookies.delete('oidc_state');

    return response;
  } catch (error) {
    logger.error(
      'the sign-in{ofWhom} failed with an unexpected error; nobody was signed in and the browser saw "Authentication failed": {error}',
      {
        component: 'auth/oidc',
        ...(signingIn ?? {}),
        ofWhom: signingIn ? ` of ${signingIn.actor}` : '',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
