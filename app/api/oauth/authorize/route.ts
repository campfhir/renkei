import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';

export async function GET(request: NextRequest) {
  const config = getConfig();
  const { searchParams } = new URL(request.url);

  const client_id = config.ATLASSIAN_CLIENT_ID;
  const redirect_uri = config.ATLASSIAN_REDIRECT_URI;
  const scope = config.ATLASSIAN_SCOPES;
  const response_type = 'code';
  const prompt = 'consent';
  const audience = 'api.atlassian.com';

  const authUrl = new URL('https://auth.atlassian.com/authorize');
  authUrl.searchParams.append('audience', audience);
  authUrl.searchParams.append('client_id', client_id);
  authUrl.searchParams.append('redirect_uri', redirect_uri);
  authUrl.searchParams.append('response_type', response_type);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('prompt', prompt);

  // Pass through state if provided
  const state = searchParams.get('state');
  if (state) {
    authUrl.searchParams.append('state', state);
  }

  console.log('[OAuth Authorize] Sending to Atlassian:', {
    audience,
    client_id,
    redirect_uri,
    response_type,
    scope: scope.substring(0, 100) + '...', // truncate for readability
    prompt,
    state: state ? 'present' : 'absent',
    full_url: authUrl.toString(),
  });

  return NextResponse.redirect(authUrl.toString());
}
