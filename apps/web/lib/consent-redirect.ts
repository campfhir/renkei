/**
 * The one redirect every connect flow ends its authorize step with: the
 * browser goes to the vendor's consent page (`authUrl`), bound to this
 * browser by the state cookie (lib/connect-flow-binding.ts).
 *
 * On the in-memory app (`fakeOAuthActive`, @renkei/provider-grants'
 * fake-oauth.ts) no vendor sits in the flow: the browser is sent straight
 * back to the app's own callback with a fake code — carrying who
 * consented, to which provider, and the request the vendor would have
 * been sent — and the real state, as a
 * vendor that approved at once would send it. The delegate then trades
 * that code for a fake token set and answers the identity reads, and the
 * callback stores the grant through its normal path.
 */

import { NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import {
  ATLASSIAN,
  fakeAuthorizationCode,
  fakeOAuthActive,
  fakeOAuthFor,
  fakeOrganization,
} from '@renkei/provider-grants';
import { bindConnectFlow } from '@/lib/connect-flow-binding';

/**
 * Redirect to `authUrl`, the vendor's consent page. `callbackUrl` is where
 * the vendor sends the browser back when `authUrl` names no redirect_uri
 * (Bitbucket's consumer has it fixed).
 */
export async function redirectToConsent(
  authUrl: URL,
  state: string,
  callbackUrl?: string
): Promise<NextResponse> {
  const target = fakeOAuthActive() ? await fakeConsent(authUrl, state, callbackUrl) : null;
  return bindConnectFlow(NextResponse.redirect(target ?? authUrl.toString()), state);
}

/** The fake consent's answer: the callback, with a fake code and the state. */
async function fakeConsent(
  authUrl: URL,
  state: string,
  callbackUrl: string | undefined
): Promise<string | null> {
  const pending = await getDataStore().pendingSignins.findByState(state);
  // A row without a provider predates the column and means Atlassian (the callback's reading).
  const provider = pending?.provider ?? ATLASSIAN;
  const callback = authUrl.searchParams.get('redirect_uri') ?? callbackUrl;
  if (!pending?.subject || !callback || !fakeOAuthFor(provider)) return null;
  const identity = await getDataStore().identities.get(pending.subject);
  const answer = new URL(callback);
  answer.searchParams.set(
    'code',
    fakeAuthorizationCode({
      subject: pending.subject,
      provider,
      scope: authUrl.searchParams.get('scope') ?? pending.scopes,
      request: authUrl.toString(),
      organization: fakeOrganization(pending.subject, identity?.email),
    })
  );
  answer.searchParams.set('state', state);
  return answer.toString();
}
