/**
 * Browser binding for a provider connect flow (Jira, Microsoft 365, WebEx,
 * Zoom, GitHub, OnBase, …).
 *
 * Every `/api/<provider>/[tenantId]/authorize` route stores its OAuth
 * `state` server-side in `pending_oidc_signin`, stamped with the signed-in
 * subject, and the shared `/api/oauth/callback` looks the row up by state
 * alone. On its own that is not enough: an attacker who starts a connect
 * flow in THEIR browser, stops at the provider's redirect, and gets a victim
 * to load the resulting callback URL (a link, an image tag, a redirect)
 * completes the flow in the victim's browser — the provider grant then lands
 * on whichever subject the pending row names. Two checks close it, and the
 * callback requires both:
 *
 * 1. This cookie. The authorize route sets it in the browser that STARTED
 *    the flow, carrying the state; the callback requires it to match the
 *    state it receives. A callback URL replayed into another browser carries
 *    no matching cookie. The same shape `oidc_state_` gives the sign-in
 *    flow (api/auth/oidc/login).
 * 2. The current session. The browser completing the flow must hold a
 *    session for the SAME subject the pending row recorded, so a grant can
 *    only ever be attached to the person who asked for it.
 *
 * `sameSite: 'lax'` still sends the cookie on the top-level redirect back
 * from the provider; `httpOnly` keeps it out of reach of page scripts. The
 * value is the state itself rather than a second secret: the state is
 * already 122 random bits, single-use, and stored only as the row's lookup
 * key — binding to it means there is one secret per flow, not two to keep in
 * step.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';

/** The cookie that binds a connect flow to the browser that started it. */
export function connectStateCookieName(): string {
  return 'connect_state';
}

/** Matches the pending row's own ten-minute expiry. */
export const CONNECT_STATE_TTL_SECONDS = 10 * 60;

/** Set on the authorize route's redirect to the provider. */
export function bindConnectFlow<T extends NextResponse>(
  response: T,
  state: string
): T {
  response.cookies.set(connectStateCookieName(), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: CONNECT_STATE_TTL_SECONDS,
  });
  return response;
}

/**
 * Whether the browser making this callback request is the one that started
 * the flow: its binding cookie for the tenant exists and equals the state.
 */
export function isConnectFlowBound(request: NextRequest, state: string): boolean {
  const cookie = request.cookies.get(connectStateCookieName())?.value;
  if (!cookie || !state) return false;
  const left = Buffer.from(cookie, 'utf8');
  const right = Buffer.from(state, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Single-use: cleared on the callback's response whatever the outcome. */
export function clearConnectFlow<T extends NextResponse>(response: T): T {
  response.cookies.delete(connectStateCookieName());
  return response;
}
