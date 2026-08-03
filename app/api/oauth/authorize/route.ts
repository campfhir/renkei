import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest) {
  const config = getConfig();

  const client_id = config.ATLASSIAN_CLIENT_ID;
  const redirect_uri = config.ATLASSIAN_REDIRECT_URI;
  const scope = config.ATLASSIAN_SCOPES;
  const response_type = 'code';
  const audience = 'api.atlassian.com';
  const state = randomUUID(); // Always generate state for CSRF protection

  const authUrl = new URL('https://auth.atlassian.com/authorize');
  authUrl.searchParams.append('audience', audience);
  authUrl.searchParams.append('client_id', client_id);
  authUrl.searchParams.append('redirect_uri', redirect_uri);
  authUrl.searchParams.append('response_type', response_type);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('state', state);

  console.log('[OAuth Authorize] Sending to Atlassian:');
  console.log('  audience:', audience);
  console.log('  client_id:', client_id);
  console.log('  redirect_uri:', redirect_uri);
  console.log('  response_type:', response_type);
  console.log('  state:', state);
  console.log('  scope (first 100 chars):', scope.substring(0, 100) + '...');
  console.log('  Full URL:', authUrl.toString());

  return NextResponse.redirect(authUrl.toString());
}
