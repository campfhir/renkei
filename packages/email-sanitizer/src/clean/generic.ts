/**
 * Link decoding — the half of cleaning that is not a judgment call.
 *
 * This file used to hold the heuristic chain too: quoted-chain truncation,
 * the RFC signature delimiter, legal-footer anchors, gateway banner
 * phrases. Those were opinions about what counts as noise, maintained here
 * on behalf of every organization at once, and they are gone — an
 * organization now expresses its own opinions as sandboxed cleaner scripts,
 * which it can read, test and change without waiting for a release.
 *
 * What stayed is what is not an opinion. A safelinks envelope is an
 * ENCODING of a URL, not a stylistic choice, and unwrapping it is
 * information-preserving in a way that dropping a signature block never is.
 * It also cannot reasonably be pushed into a script: the sandbox has a
 * 250ms budget and no URL parser, and every tenant would be reimplementing
 * percent-decoding and nested-gateway peeling against the same four
 * vendors. Decoding belongs in code; judgment belongs to the tenant.
 */

import { collapseWhitespace } from '../normalize';

const SAFE_LINKS_HOST = /^https:\/\/[a-z0-9.-]*\.safelinks\.protection\.outlook\.com\//i;

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
  'fbclid',
  'gclid',
]);

/**
 * Every link-rewriting gateway we have seen in this org's mail.
 *
 * These matter more than they look. A wrapped link is a few hundred
 * characters of opaque token where a readable URL used to be, and mail and
 * invites are FULL of links — so an unwrapped body is largely gibberish by
 * volume, which wastes the chunk budget and drags the embedding toward
 * nothing in particular.
 *
 * They also NEST: a message relayed through two gateways arrives as
 * safelinks wrapping urldefense. Unwrapping once leaves the inner wrapper
 * sitting there, so the loop below runs until the URL stops changing.
 */
const PROOFPOINT_V3 = /^https:\/\/urldefense\.com\/v3\/__(.+?)__;/i;
const PROOFPOINT_V2 = /^https:\/\/urldefense\.proofpoint\.com\/v2\/url\?/i;
const BARRACUDA = /^https:\/\/linkprotect\.cudasvc\.com\/url\?/i;
const MIMECAST = /^https:\/\/protect[a-z0-9-]*\.mimecast\.com\//i;

function fromParam(url: string, parameter: string): string | null {
  try {
    const inner = new URL(url).searchParams.get(parameter);
    return inner || null;
  } catch {
    return null;
  }
}

/** One layer off, or the URL unchanged when it is not wrapped. */
function unwrapOnce(url: string): string {
  if (SAFE_LINKS_HOST.test(url)) return fromParam(url, 'url') ?? url;

  // Proofpoint v3 embeds the target between __ markers rather than in a
  // query parameter.
  const v3 = PROOFPOINT_V3.exec(url);
  if (v3?.[1]) {
    // v3 substitutes `*` for some characters and describes them in the
    // trailing token; the token is not recoverable here, so the asterisks
    // are dropped. A very slightly lossy URL beats 300 characters of
    // wrapper.
    return v3[1].replace(/\*+/g, '');
  }

  if (PROOFPOINT_V2.test(url)) {
    const encoded = fromParam(url, 'u');
    // v2's own encoding: `-` for `%` and `_` for `/`, then percent-decoding.
    if (encoded) {
      const restored = encoded.replace(/-/g, '%').replace(/_/g, '/');
      try {
        return decodeURIComponent(restored);
      } catch {
        return restored;
      }
    }
  }

  if (BARRACUDA.test(url)) return fromParam(url, 'a') ?? url;

  // Mimecast tokens are not reversible — the original lives only in their
  // service. The domain hint it carries is still far better than the token.
  if (MIMECAST.test(url)) {
    const domain = fromParam(url, 'domain');
    return domain ? `https://${domain.replace(/^https?:\/\//i, '')}` : url;
  }

  return url;
}

function unwrapRedirects(url: string): string {
  let current = url;
  // Bounded: wrappers nest two deep in practice, and a cycle must not spin.
  for (let layer = 0; layer < 4; layer += 1) {
    const next = unwrapOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return url;
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return url;
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Unwrap known tracking-redirect wrappers and strip tracking query params from bare URLs. */
export function defluffUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => stripTrackingParams(unwrapRedirects(match)));
}

/**
 * Everything that happens to a body before a tenant's own scripts see it.
 *
 * Deliberately thin: unwrap the links, tidy the whitespace, stop. Anything
 * more opinionated is a script's job, and a script that receives text this
 * lightly touched can still see the structure it needs to make its own
 * decisions — a quoted chain it might want to cut is still recognisably a
 * quoted chain.
 */
export function decodeBody(text: string): string {
  return collapseWhitespace(defluffUrls(text));
}
