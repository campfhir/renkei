import { NextRequest, NextResponse } from 'next/server';
import {
  bindConnectFlow,
  clearConnectFlow,
  connectStateCookieName,
  isConnectFlowBound,
} from './connect-flow-binding';

const TENANT = '00000000-0000-4000-8000-000000000001';
const STATE = 'f6a1c4b2-0d3e-4f5a-8b6c-7d8e9f0a1b2c';

function callbackWith(cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest(`http://localhost/api/oauth/callback?code=c&state=${STATE}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe('connect-flow browser binding', () => {
  it('sets an httpOnly, lax, path-wide cookie carrying the state', () => {
    const response = bindConnectFlow(
      NextResponse.redirect('https://idp.example/auth'),
      STATE
    );
    const cookie = response.cookies.get(connectStateCookieName());
    expect(cookie?.value).toBe(STATE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBe(600);
  });

  it('accepts a callback whose cookie matches the state', () => {
    const request = callbackWith({ [connectStateCookieName()]: STATE });
    expect(isConnectFlowBound(request, STATE)).toBe(true);
  });

  it('refuses a callback with no binding cookie', () => {
    expect(isConnectFlowBound(callbackWith({}), STATE)).toBe(false);
  });

  it('refuses a callback whose cookie carries a different state', () => {
    const request = callbackWith({ [connectStateCookieName()]: 'someone-elses-state' });
    expect(isConnectFlowBound(request, STATE)).toBe(false);
  });

  it("refuses a cookie bound to another tenant's flow", () => {
    const request = callbackWith({ [connectStateCookieName()]: STATE });
    expect(isConnectFlowBound(request, STATE)).toBe(false);
  });

  it('clears the cookie on the response', () => {
    const response = clearConnectFlow(NextResponse.json({ ok: true }));
    const cookie = response.cookies.get(connectStateCookieName());
    // NextResponse models deletion as the cookie set to empty with maxAge 0.
    expect(cookie?.value ?? '').toBe('');
    expect(cookie?.maxAge ?? 0).toBe(0);
  });
});
