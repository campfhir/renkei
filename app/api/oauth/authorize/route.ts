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

  const authUrl = new URL('https://auth.atlassian.com/authorize');
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

  return NextResponse.redirect(authUrl.toString());
}
