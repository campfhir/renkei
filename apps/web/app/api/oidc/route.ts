import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { setTenantOidc, createTenantOidcIfAbsent } from '@/lib/tenant-operations';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import type { Session } from '@/lib/session';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { safeFetch, assertSafeHttpsUrl, BlockedUrlError } from '@/lib/safe-fetch';
import {
  SETUP_SECRET_ENV,
  SETUP_SECRET_HEADER,
  SETUP_SECRET_MIN_CHARS,
  identityProviderConfigured,
  verifySetupSecret,
} from '@/lib/setup-secret';

/** The caller's session when they are an operator, else null. */
async function requireOperator(): Promise<Session | null> {
  return checkAccess([ROLE_OPERATOR]);
}

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

interface OidcConfigRequest {
  discoveryEndpoint: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  operatorIdpValue?: string;
  userIdpValue?: string;
  groupsClaim?: string;
}

function isOidcConfigRequest(data: unknown): data is OidcConfigRequest {
  if (typeof data !== 'object' || data === null) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.discoveryEndpoint === 'string' &&
    typeof obj.clientId === 'string' &&
    typeof obj.clientSecret === 'string'
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // First configuration needs the setup secret; every change after it is
    // operator-only.
    //
    // The first write cannot require a session because operator identity is
    // itself derived from OIDC: until the deployment has an identity
    // provider, nobody can hold an operator session. The SETUP_SECRET in
    // the app's environment (lib/setup-secret.ts) is what stands in for a
    // session here. Once a provider is set an operator can exist, and from
    // then on only they may change it -- which is the part that matters,
    // since whoever controls this record controls who becomes an operator.
    const configured = await identityProviderConfigured();
    const operator = configured ? await requireOperator() : null;
    // Who is making the change, for the lines below: the operator, or the
    // setup-secret request a first configuration arrives as.
    const by = operator ? who(operator) : null;
    const changedBy = by?.actor ?? 'the setup-secret request';
    if (configured) {
      if (!operator) {
        const denied = UNAUTHORIZED();
        logger.warn(
          'a request without an operator session tried to change the identity provider; refused, nothing was changed',
          {
            component: 'auth/oidc',
            status: denied.status,
          }
        );
        return denied;
      }
    } else {
      const verdict = verifySetupSecret(request.headers.get(SETUP_SECRET_HEADER));
      if (verdict !== 'ok') {
        logger.warn(
          'a request tried to configure the identity provider for the first time without a valid setup secret ({verdict}); refused, nothing was changed',
          {
            component: 'auth/oidc',
            verdict,
          }
        );
        return NextResponse.json(
          {
            error:
              verdict === 'unset'
                ? `No setup secret is configured. Set ${SETUP_SECRET_ENV} in the app's environment and restart it.`
                : verdict === 'short'
                  ? `${SETUP_SECRET_ENV} is too short to be a secret (at least ${SETUP_SECRET_MIN_CHARS} characters).`
                  : `The setup secret is missing or wrong. Use the ${SETUP_SECRET_ENV} from the app's environment.`,
          },
          { status: 401 }
        );
      }
    }

    const body = await request.json();
    if (!isOidcConfigRequest(body)) {
      return NextResponse.json({ error: 'Invalid request body format' }, { status: 400 });
    }

    // Validate required fields
    if (!body.discoveryEndpoint || !body.clientId || !body.clientSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: discoveryEndpoint, clientId, clientSecret' },
        { status: 400 }
      );
    }

    // The discovery endpoint is caller-supplied (and before the first
    // configuration this whole POST carries no session), so the fetch is SSRF-guarded: https
    // only, no localhost/private/metadata targets. Without it, this endpoint
    // could be pointed at 169.254.169.254 or an internal service.
    try {
      assertSafeHttpsUrl(body.discoveryEndpoint);
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        return NextResponse.json(
          { error: `Discovery endpoint is not an allowed URL: ${error.message}` },
          { status: 400 }
        );
      }
      throw error;
    }

    // Fetch and validate discovery endpoint
    let issuer: string;
    try {
      const discoveryResponse = await safeFetch(body.discoveryEndpoint);
      if (!discoveryResponse.ok) {
        return NextResponse.json(
          { error: `Failed to fetch discovery endpoint: ${discoveryResponse.status}` },
          { status: 400 }
        );
      }

      const discovery = await discoveryResponse.json();
      issuer = discovery.issuer;

      if (!issuer) {
        return NextResponse.json(
          { error: 'Discovery endpoint missing issuer field' },
          { status: 400 }
        );
      }

      // The issuer is stored and later fetched (login/callback build the
      // discovery URL from it), so it must itself be a safe public https URL —
      // a discovery document must not smuggle an internal issuer past the guard.
      assertSafeHttpsUrl(issuer);

      logger.debug(
        '{changedBy}: the discovery document at {discoveryEndpoint} names issuer {issuer}',
        {
          component: 'auth/oidc',
          ...(by ?? {}),
          changedBy,
          discoveryEndpoint: body.discoveryEndpoint,
          issuer,
        }
      );
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        return NextResponse.json(
          { error: `Discovery endpoint is not an allowed URL: ${error.message}` },
          { status: 400 }
        );
      }
      logger.error(
        '{changedBy} tried to set the identity provider, but its discovery document at {discoveryEndpoint} could not be fetched; nothing was saved: {error}',
        {
          component: 'auth/oidc',
          ...(by ?? {}),
          changedBy,
          discoveryEndpoint: body.discoveryEndpoint,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
      );
      return NextResponse.json(
        { error: 'Failed to fetch OIDC discovery endpoint' },
        { status: 400 }
      );
    }

    const config = {
      issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      roleClaim: body.roleClaim,
      operatorIdpValue: body.operatorIdpValue || null,
      userIdpValue: body.userIdpValue || null,
      groupsClaim: body.groupsClaim || null,
    };

    if (configured) {
      // Authenticated update.
      const setResult = await setTenantOidc(config);
      if (!setResult.ok) {
        logger.error(
          '{changedBy} changed the identity provider to {issuer}, but the configuration was not saved: {error}',
          {
            component: 'auth/oidc',
            ...(by ?? {}),
            changedBy,
            issuer,
            error: String(setResult.err),
          }
        );
        return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
      }

      logger.info('{changedBy} changed the identity provider to {issuer}', {
        component: 'auth/oidc',
        ...(by ?? {}),
        changedBy,
        issuer,
        clientId: body.clientId,
      });
      return NextResponse.json({ success: true });
    }

    // First configuration. Insert-only, so a configuration created while
    // the discovery fetch above was in flight is not overwritten by this
    // caller; they are told to authenticate instead.
    const createResult = await createTenantOidcIfAbsent(config);
    if (!createResult.ok) {
      logger.error(
        'the setup-secret request configured the identity provider {issuer}, but the configuration was not saved: {error}',
        {
          component: 'auth/oidc',
          issuer,
          error: String(createResult.err),
        }
      );
      return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
    }

    if (!createResult.val) {
      logger.warn(
        'the setup-secret request to configure the identity provider {issuer} lost a race with a configuration written meanwhile; nothing was changed and the caller was told to sign in as an operator',
        {
          component: 'auth/oidc',
          issuer,
        }
      );
      return NextResponse.json(
        {
          error:
            'This deployment already has an identity provider. Changing it requires an operator session.',
        },
        { status: 409 }
      );
    }

    // From here on SETUP_SECRET is ignored: a provider exists, so only an
    // operator session changes it. The variable can be removed from the
    // environment.
    //
    // Worth a record of its own: this is the one write to this table that
    // no session authenticated — only the setup secret — and it decides
    // who can become an operator.
    logger.warn(
      'the identity provider of this previously unconfigured deployment was set to {issuer} with the setup secret, not by a signed-in person; from now on only an operator may change it',
      {
        component: 'auth/oidc',
        issuer,
        clientId: body.clientId,
        operatorIdpValue: body.operatorIdpValue || null,
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error(
      'a request to change the identity provider failed with an unexpected error; nothing was saved: {error}',
      {
        component: 'auth/oidc',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
    return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  // Operator-only, and checked before anything is read. This returns the
  // issuer, client id and the claim mapping that decides who becomes an
  // operator — which is the reconnaissance for an attack on POST, so it is
  // gated even though no secret is in the response.
  const operator = await requireOperator();
  if (!operator) return UNAUTHORIZED();

  try {
    // Get OIDC configuration (the sealed client secret stays out of the answer)
    const oidc = await getDataStore().oidcConfig.get();

    if (!oidc) {
      return NextResponse.json({ configured: false });
    }

    return NextResponse.json({
      configured: true,
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      roleClaim: oidc.roleClaim,
      operatorIdpValue: oidc.operatorIdpValue,
      userIdpValue: oidc.userIdpValue,
      groupsClaim: oidc.groupsClaim,
    });
  } catch (error) {
    logger.error(
      '{actor} opened the identity provider settings, but the configuration could not be read: {error}',
      {
        component: 'auth/oidc',
        ...who(operator),
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
    return NextResponse.json({ error: 'Failed to fetch OIDC configuration' }, { status: 500 });
  }
}
