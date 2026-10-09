import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { setTenantOidc, createTenantOidcIfAbsent } from '@/lib/tenant-operations';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { logger } from '@/lib/logger';
import { safeFetch, assertSafeHttpsUrl, BlockedUrlError } from '@/lib/safe-fetch';
import { BOOTSTRAP_SECRET_HEADER, verifyBootstrapSecret } from '@/lib/tenant-bootstrap';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

/**
 * Confirm the caller is an operator *of this tenant*.
 *
 * checkAccess is tenant-scoped by construction — the session cookie is
 * per-tenant — so an operator of one tenant cannot reconfigure another's
 * identity provider.
 */
async function requireTenantOperator(tenantId: string): Promise<NextResponse | null> {
  const access = await checkAccess(tenantId, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/** Whether this tenant already has an identity provider configured. */
async function hasOidcConfig(db: Kysely<DB>, tenantId: string): Promise<boolean> {
  const existing = await db
    .selectFrom('tenant_oidc')
    .select('client_id')
    .executeTakeFirst();
  return Boolean(existing);
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
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'bootstrap_secret_hash', 'bootstrap_secret_expires_at'])
      .where('id', '=', tenantId)
      .executeTakeFirst();


    // First configuration needs the one-time bootstrap secret; every change
    // after it is operator-only.
    //
    // The first write cannot require a session because operator identity is
    // itself derived from OIDC: until a tenant has an identity provider,
    // nobody can hold an operator session for it. It used to be open to
    // anyone holding the tenant id — which travels in the creator's URL and
    // in the create response — so whoever posted an IdP first owned the
    // tenant. The secret minted at creation (lib/tenant-bootstrap.ts) and
    // shown once to the creator is what stands in for a session here. Once
    // a provider is set an operator can exist, and from then on only they
    // may change it -- which is the part that matters, since whoever
    // controls this record controls who becomes an operator.
    const configured = await hasOidcConfig(db, tenantId);
    if (configured) {
      const denied = await requireTenantOperator(tenantId);
      if (denied) {
        logger.warn('Rejected unauthorised attempt to change identity provider', {
          component: 'auth/oidc',
          status: denied.status,
        });
        return denied;
      }
    } else {
      const verdict = verifyBootstrapSecret(request.headers.get(BOOTSTRAP_SECRET_HEADER), tenant);
      if (verdict !== 'ok') {
        logger.warn('Rejected identity-provider bootstrap without a valid secret ({verdict})', {
          component: 'auth/oidc',
          verdict,
        });
        return NextResponse.json(
          {
            error:
              verdict === 'none-issued'
                ? 'This organization has no onboarding secret; an operator must configure its identity provider directly.'
                : verdict === 'expired'
                  ? 'The onboarding secret has expired. Create the organization again.'
                  : 'The onboarding secret is missing or wrong. Use the one shown when the organization was created.',
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

    // The discovery endpoint is caller-supplied (and on an unconfigured tenant
    // this whole POST is unauthenticated), so the fetch is SSRF-guarded: https
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
      const setResult = await setTenantOidc(tenantId, config);
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

    // Unauthenticated bootstrap. Insert-only, so a configuration created while
    // the discovery fetch above was in flight is not overwritten by this
    // caller; they are told to authenticate instead.
    const createResult = await createTenantOidcIfAbsent(tenantId, config);
    if (!createResult.ok) {
      logger.error('Failed to save OIDC configuration: {error}', {
        component: 'auth/oidc',
        error: String(createResult.err),
      });
      return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
    }

    if (!createResult.val) {
      logger.warn('Bootstrap lost a race with an existing configuration', {
        component: 'auth/oidc',
      });
      return NextResponse.json(
        {
          error:
            'This tenant already has an identity provider. Changing it requires an operator session.',
        },
        { status: 409 }
      );
    }

    // Spent: the secret was for exactly this write.
    await db
      .updateTable('tenants')
      .set({ bootstrap_secret_hash: null, bootstrap_secret_expires_at: null })
      .where('id', '=', tenantId)
      .execute();

    // Worth a record of its own: this is the one write to this table that
    // no session authenticated — only the creator's one-time secret — and it
    // decides who can become an operator.
    logger.warn('Identity provider claimed for previously unconfigured tenant', {
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {

  // Operator-only, and checked before anything is read. This returns the
  // issuer, client id and the claim mapping that decides who becomes an
  // operator — which is the reconnaissance for an attack on POST, so it is
  // gated even though no secret is in the response.
  const denied = await requireTenantOperator(tenantId);
  if (denied) return denied;

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();


    // Get OIDC configuration
    const oidc = await db
      .selectFrom('tenant_oidc')
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
