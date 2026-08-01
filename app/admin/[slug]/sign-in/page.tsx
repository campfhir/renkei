import { getDatabase } from '@/lib/db';
import { redirect } from 'next/navigation';
import { getConfig } from '@/lib/env';
import { randomUUID } from 'crypto';

export default async function SignInPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDatabase();
  const config = getConfig();

  // Fetch tenant and OIDC config
  const tenant = await db
    .selectFrom('tenants')
    .select(['id'])
    .where('slug', '=', slug)
    .executeTakeFirst();

  if (!tenant) {
    redirect(`/admin/${slug}`);
  }

  const oidcConfig = await db
    .selectFrom('tenant_oidc')
    .select(['issuer', 'client_id', 'authorization_endpoint'])
    .where('tenant_id', '=', tenant.id)
    .executeTakeFirst();

  if (!oidcConfig) {
    redirect(`/admin/${slug}`);
  }

  // Generate OIDC authorization request
  const state = randomUUID();
  const redirectUri = `${config.PUBLIC_BASE_URL}/api/oauth/callback`;

  // Store state in a pending sign-in (would need a DB table for this)
  // TODO: Store state + tenant_id + redirect_uri for verification

  // Build authorization URL
  const authUrl = new URL(oidcConfig.authorization_endpoint);
  authUrl.searchParams.append('client_id', oidcConfig.client_id);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'openid email profile');
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('state', state);

  redirect(authUrl.toString());
}
