import { getDatabase } from '@/lib/db';
import { redirect } from 'next/navigation';
import { getConfig } from '@/lib/env';
import { randomUUID } from 'crypto';

const SIGN_IN_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + SIGN_IN_TTL_MS).toISOString();

  // Store pending sign-in for verification
  // TODO: Implement with actual DB table (pending_oidc_signin)
  // For MVP, we skip state verification in callback
  try {
    // Placeholder for storing state - in production this would be:
    // await db.insertInto('pending_oidc_signin').values({
    //   state,
    //   nonce,
    //   tenant_id: tenant.id,
    //   expires_at: expiresAt,
    //   created_at: new Date().toISOString(),
    // }).execute();
  } catch (err) {
    console.error('Failed to store sign-in state:', err);
  }

  // Build authorization URL
  const authUrl = new URL(oidcConfig.authorization_endpoint);
  authUrl.searchParams.append('client_id', oidcConfig.client_id);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'openid email profile');
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('nonce', nonce);

  redirect(authUrl.toString());
}
