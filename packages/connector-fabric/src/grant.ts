/**
 * The person's own Fabric grant as a FabricFetch: the delegate attaches
 * and refreshes the token (docs/delegate-key-design.md); nothing here ever
 * holds one. When the delegate answers a request itself — no grant, a
 * revoked one, a locked key — the request never reached Fabric, so it is
 * thrown as a FabricRefusal in Renkei's words instead of being read as
 * Fabric's answer.
 */

import { FABRIC } from '@renkei/provider-grants';
import { delegateRefusal, grantFetch } from '@renkei/delegate-client';
import { FabricRefusal, type FabricFetch } from './api';

function defaultPhrase(tag: string): string {
  switch (tag) {
    case 'NO_GRANT':
      return 'Microsoft Fabric is not connected. Connect it on the Connectors page, then try again.';
    case 'GRANT_REVOKED':
      return 'Your Microsoft Fabric authorization was revoked. Reconnect it on the Connectors page.';
    case 'NEEDS_DELEGATION':
      return 'Your encryption key is not available to Renkei right now, so Microsoft Fabric cannot act for you. Sign in again to continue.';
    default:
      return `The Microsoft Fabric request could not be made (${tag}).`;
  }
}

export function fabricGrantFetcher(
  subject: string,
  phrase: (tag: string) => string = defaultPhrase
): FabricFetch {
  const send = grantFetch({ provider: FABRIC, subject });
  return async (url, init) => {
    const response = await send(url, init);
    const refusal = delegateRefusal(response);
    if (refusal) throw new FabricRefusal(phrase(refusal));
    return response;
  };
}
