/**
 * The delegate's verdicts on a grant, in the words the per-connector
 * resolvers used to say them. Before the delegate, each resolver read the
 * grant row, refreshed the token and phrased its own refusal ("WebEx is
 * not connected…", "Could not refresh the Zoom token…"); now the delegate
 * does the reading and refreshing and answers a tag, and this is the one
 * place the tag becomes a sentence a person (or a model) can act on.
 */

import { delegateRefusal } from '@renkei/delegate-client';

/** The sentence for a grant-op or proxy refusal tag; `label` names the connector ("WebEx"). */
export function grantRefusalText(error: string, label: string): string {
  switch (error) {
    case 'NO_GRANT':
      return `${label} is not connected. Connect it on the Connectors page, then try again.`;
    case 'GRANT_UNREADABLE':
      return `Could not read the ${label} grant.`;
    case 'NEEDS_DELEGATION':
      return `Your encryption key is not available to Renkei right now, so ${label} cannot act for you. Sign in again to continue.`;
    case 'GRANT_REVOKED':
      return `Your ${label} authorization was revoked. Reconnect it on the Connectors page.`;
    case 'REFRESH_FAILED':
      return `Could not refresh the ${label} token; try again shortly.`;
    case 'NOT_CONFIGURED':
      return `${label} integration is no longer configured.`;
    case 'host_not_allowed':
      return `That URL is not ${label}'s API, so the request was not sent.`;
    case 'DELEGATE_UNCONFIGURED':
      return (
        'The credential delegate is not configured (DELEGATE_WORKER_URL / ' +
        'DELEGATE_WORKER_API_KEY), so no connector call can be made.'
      );
    case 'DELEGATE_UNREACHABLE':
      return 'The credential delegate could not be reached; try again shortly.';
    default:
      return `The ${label} request could not be made (${error}).`;
  }
}

/**
 * The refusal text when the delegate answered a proxied request itself
 * (never reached the provider); null for a real provider answer, which
 * the caller reads as it always did.
 */
export function refusalTextOf(response: Response, label: string): string | null {
  const refusal = delegateRefusal(response);
  return refusal ? grantRefusalText(refusal, label) : null;
}
