/**
 * The rule for a base URL an operator gives an organisation-wide service —
 * the LLM, embeddings, OCR and web-search endpoints. Every prompt, tool
 * result, document text and knowledge passage goes there with the API key,
 * so the transport is not a free-text field:
 *
 *  - https is accepted for any host. Private gateways are legitimate here,
 *    so (unlike safeFetch) a private address is not refused;
 *  - plain http is accepted only for a host that resolves to a private
 *    network and nothing public (checkInsecureTransport, the same rule the
 *    Mirth, ADManager and OnBase instances follow);
 *  - link-local and cloud-metadata addresses are refused outright, whatever
 *    the scheme: no model gateway lives there, and an operator-controlled
 *    URL that does is a probe of the host's own infrastructure.
 */

import net from 'node:net';
import { checkInsecureTransport, type AddressLookup } from '@/lib/insecure-transport';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

/** An IPv4 169.254/16, IPv6 fe80::/10, or an IPv4-mapped IPv6 spelling of 169.254/16. */
function isLinkLocal(host: string): boolean {
  if (net.isIPv4(host)) return host.startsWith('169.254.');
  if (!net.isIPv6(host)) return false;
  const lower = host.toLowerCase();
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // ::ffff:a9fe:xxxx (hex) or ::ffff:169.254.x.x (dotted)
  return /^::ffff:(a9fe:[0-9a-f]{1,4}|169\.254\.\d+\.\d+)$/.test(lower);
}

export async function checkServiceEndpoint(
  raw: string,
  resolve?: AddressLookup
): Promise<{ ok: true } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'The base URL must be an absolute URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The base URL must be an http(s) URL.' };
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (isLinkLocal(host) || METADATA_HOSTS.has(host)) {
    return { ok: false, error: `${host} is a link-local or metadata address and cannot be used.` };
  }
  if (url.protocol === 'http:') {
    const verdict = await checkInsecureTransport(
      { modes: ['plaintext_http'], production: false, urls: [url.toString()] },
      resolve
    );
    if (!verdict.ok) {
      return {
        ok: false,
        error: `Use https: ${verdict.error} Plain http is only allowed to a host on a private network.`,
      };
    }
  }
  return { ok: true };
}
