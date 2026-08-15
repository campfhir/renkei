/**
 * The one thing every per-connector XAuth interface shares: how to report a
 * LOCAL auth failure — a missing scope, an unresolved grant, no cloud id on
 * the connection — as opposed to a real reply from the provider.
 *
 * Every `fetch()` implementation (`oauthJsmOpsAuth`, `oauthWebexAuth`,
 * `oauthZoomAuth`, `oauthGraphAuth`, and their denied/pat counterparts)
 * returns one of these instead of throwing or adding a second failure
 * channel, so a handler's existing
 * `if (!response.ok) return errText(await describeXFailure(response))`
 * keeps working with no special case for "we never actually reached the
 * network." A thrown error or a bespoke `{ ok: false, error }` shape would
 * each need their own handling at every one of the ~150 call sites this
 * covers; a Response needs none.
 */
export function authFailure(message: string, status = 400): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
