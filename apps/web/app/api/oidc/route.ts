import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { setTenantOidc, createTenantOidcIfAbsent } from '@/lib/tenant-operations';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { logger } from '@/lib/logger';
import { safeFetch, assertSafeHttpsUrl, BlockedUrlError } from '@/lib/safe-fetch';
import {
  SETUP_SECRET_HEADER,
  clearSetupSecret,
  identityProviderConfigured,
  verifySetupSecret,
} from '@/lib/setup-secret';

/** Confirm the caller is an operator. */
async function requireOperator(): Promise<NextResponse | null> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

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

export async function POST(
  request: NextRequest
): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // First configuration needs the one-time setup secret; every change
    // after it is operator-only.
    //
    // The first write cannot require a session because operator identity is
    // itself derived from OIDC: until the deployment has an identity
    // provider, nobody can hold an operator session. The secret the setup
    // page mints into the server log (lib/setup-secret.ts) is what stands in
    // for a session here. Once a provider is set an operator can exist, and
    // from then on only they may change it -- which is the part that
    // matters, since whoever controls this record controls who becomes an
    // operator.
    const configured = await identityProviderConfigured(db);
    if (configured) {
      const denied = await requireOperator();
      if (denied) {
        logger.warn('Rejected unauthorised attempt to change identity provider', {
          component: 'auth/oidc',
          status: denied.status,
        });
        return denied;
      }
    } else {
      const verdict = await verifySetupSecret(db, request.headers.get(SETUP_SECRET_HEADER));
      if (verdict !== 'ok') {
        logger.warn('Rejected identity-provider setup without a valid secret ({verdict})', {
          component: 'auth/oidc',
          verdict,
        });
        return NextResponse.json(
          {
            error:
              verdict === 'none-issued'
                ? 'No setup secret has been issued. Open the setup page first; it writes one to the server log.'
                : verdict === 'expired'
                  ? 'The setup secret has expired. Reload the setup page for a fresh one in the server log.'
                  : 'The setup secret is missing or wrong. Use the one in the server log.',
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

      logger.debug('Fetched issuer from discovery: {issuer}', {
        component: 'auth/oidc',
        issuer,
      });
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        return NextResponse.json(
          { error: `Discovery endpoint is not an allowed URL: ${error.message}` },
          { status: 400 }
        );
      }
      logger.error('Failed to fetch discovery endpoint: {error}', {
        component: 'auth/oidc',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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
        logger.error('Failed to save OIDC configuration: {error}', {
          component: 'auth/oidc',
          error: String(setResult.err),
        });
        return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
      }

      logger.info('Identity provider updated by operator', {
        component: 'auth/oidc',
        issuer,
      });
      return NextResponse.json({ success: true });
    }

    // First configuration. Insert-only, so a configuration created while
    // the discovery fetch above was in flight is not overwritten by this
    // caller; they are told to authenticate instead.
    const createResult = await createTenantOidcIfAbsent(config);
    if (!createResult.ok) {
      logger.error('Failed to save OIDC configuration: {error}', {
        component: 'auth/oidc',
        error: String(createResult.err),
      });
      return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
    }

    if (!createResult.val) {
      logger.warn('Setup lost a race with an existing configuration', {
        component: 'auth/oidc',
      });
      return NextResponse.json(
        {
          error:
            'This deployment already has an identity provider. Changing it requires an operator session.',
        },
        { status: 409 }
      );
    }

    // Spent: the secret was for exactly this write.
    await clearSetupSecret(db);

    // Worth a record of its own: this is the one write to this table that
    // no session authenticated — only the one-time setup secret — and it
    // decides who can become an operator.
    logger.warn('Identity provider configured for a previously unconfigured deployment', {
      component: 'auth/oidc',
      issuer,
      clientId: body.clientId,
      operatorIdpValue: body.operatorIdpValue || null,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Config error: {error}', {
      component: 'auth/oidc',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {

  // Operator-only, and checked before anything is read. This returns the
  // issuer, client id and the claim mapping that decides who becomes an
  // operator — which is the reconnaissance for an attack on POST, so it is
  // gated even though no secret is in the response.
  const denied = await requireOperator();
  if (denied) return denied;

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Get OIDC configuration
    const oidc = await db
      .selectFrom('oidc_config')
      .select([
        'issuer',
        'client_id',
        'role_claim',
        'operator_idp_value',
        'user_idp_value',
        'groups_claim',
      ])
      .executeTakeFirst();

    if (!oidc) {
      return NextResponse.json({ configured: false });
    }

    return NextResponse.json({
      configured: true,
      issuer: oidc.issuer,
      clientId: oidc.client_id,
      roleClaim: oidc.role_claim,
      operatorIdpValue: oidc.operator_idp_value,
      userIdpValue: oidc.user_idp_value,
      groupsClaim: oidc.groups_claim,
    });
  } catch (error) {
    logger.error('Config fetch error: {error}', {
      component: 'auth/oidc',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Failed to fetch OIDC configuration' }, { status: 500 });
  }
}
