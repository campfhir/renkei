/**
 * What a non-2xx answer means, told apart by who sent it. Azure Blob's own
 * refusals carry `x-ms-error-code` and an XML body whose `<Message>` (and,
 * on a signing failure, `<AuthenticationErrorDetail>` — the string-to-sign
 * the service computed) says exactly what was wrong. Anything without
 * that header answered on Storage's behalf: a Front Door WAF block, a
 * route to the wrong origin, a proxy — usually with `x-azure-ref` and an
 * HTML body. Collapsing both into "403" hid the one clue that settles a
 * failed connection test, so the message names the sender.
 *
 * Pure: headers and body text in, kind and sentence out.
 */

import type { BlobError } from './contract';

const BODY_QUOTE_MAX = 400;

export interface Refusal {
  kind: BlobError;
  message: string;
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

function plainText(body: string): string {
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BODY_QUOTE_MAX);
}

function kindOf(status: number): BlobError {
  if (status === 404) return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'AUTH';
  return 'PROVIDER_ERROR';
}

export function describeRefusal(
  status: number,
  headers: { get(name: string): string | null },
  body: string
): Refusal {
  const kind = kindOf(status);
  const code = headers.get('x-ms-error-code') ?? tag(body, 'Code');
  const requestId = headers.get('x-ms-request-id');
  const fromStorage = code !== null || /<Error>/i.test(body);

  if (fromStorage) {
    const parts = [`Azure Blob ${status}${code ? ` ${code}` : ''}`];
    const message = tag(body, 'Message');
    if (message) parts.push(message.split('\n')[0].trim());
    const detail = tag(body, 'AuthenticationErrorDetail');
    if (detail) parts.push(detail.replace(/\s+/g, ' ').slice(0, BODY_QUOTE_MAX));
    if (requestId) parts.push(`request ${requestId}`);
    return { kind, message: parts.join(': ') };
  }

  const ref = headers.get('x-azure-ref');
  const quoted = plainText(body);
  const where = ref ? `x-azure-ref ${ref}` : 'no x-ms-error-code in the answer';
  const advice =
    status === 401 || status === 403
      ? 'A Front Door WAF rule or route refused the request before it reached the storage account — look the reference up in the profile’s WAF logs, and make sure the endpoint is a route that forwards to the account, not the app’s own host.'
      : 'The answer came from whatever fronts the endpoint, not from the storage account — check the route’s origin.';
  return {
    kind,
    message: `Blocked before reaching Azure Blob (${status} from the edge; ${where}). ${advice}${quoted ? ` The edge said: ${quoted}` : ''}`,
  };
}
