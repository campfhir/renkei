import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF guard for `sandbox_download_url`, `sandbox_fetch_page`, the sandbox
 * browser and (through apps/web/lib/safe-fetch.ts) the web app's OIDC
 * discovery and token fetches — every operation that reaches a URL a
 * caller or a tenant's configuration supplied.
 *
 * Three layers, each building on the last:
 *   - `assertSafeHttpsUrl` / `assertSafeHostname` — synchronous, DNS-free:
 *     https only, no localhost family, no IP literal in a private or
 *     reserved range.
 *   - `assertPublicHttpsUrl` / `resolvePublicAddress` — the above, then a
 *     DNS resolution whose EVERY answer must be public. A name that does
 *     not resolve is refused too: an unresolvable host is not a host to
 *     reach, and letting the real request "surface" the failure would
 *     leave a second lookup for a rebinding answer to land on.
 *   - `guardedFetch` (guarded-fetch.ts) — the request itself, dialled at
 *     the very address the resolution verified (the TLS server name and
 *     the Host header stay the original hostname), with redirects followed
 *     by hand so every hop goes through the same guard. That closes the
 *     two gaps a resolve-then-fetch check leaves: DNS rebinding between
 *     the lookup and the connect, and a public URL that answers with a
 *     Location into a private range. The browser's egress proxy
 *     (apps/worker-sandbox/src/browser-proxy.ts) pins the same way for
 *     every connection Chromium makes.
 */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost']);

/** True for loopback, private, link-local (incl. the cloud metadata IP), CGNAT, and reserved IPv4. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/3 multicast + reserved
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null when it is
 * not one. Handles `::` compression and a dotted-quad tail.
 */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const tail = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const quad = tail.slice(2).map(Number);
    if (quad.some((n) => n > 255)) return null;
    text = `${tail[1]}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN
  );
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

const embeddedIPv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Allow-list by scope: only global unicast (2000::/3) is reachable, and the
 * transitional forms that embed an IPv4 destination (mapped, compatible,
 * NAT64, 6to4) are judged by the address they embed. A deny-list of
 * prefixes keeps missing spellings; this does not.
 */
function isBlockedIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible), incl. :: and ::1
  if (upperZero && g4 === 0 && g5 === 0xffff) return isBlockedIPv4(embeddedIPv4(g6, g7));
  if (upperZero && g4 === 0 && g5 === 0) return true;
  // 64:ff9b::/96 NAT64 well-known prefix
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4(embeddedIPv4(g6, g7));
  }
  // 2002::/16 6to4 embeds an IPv4 in groups 1-2
  if (g0 === 0x2002) return isBlockedIPv4(embeddedIPv4(g1, g2));
  // Everything outside global unicast 2000::/3 (loopback, link-local,
  // unique-local, site-local, multicast, documentation-free reserved).
  return (g0 & 0xe000) !== 0x2000;
}

/** Whether an IP literal is in a private/reserved range the worker refuses to reach. */
export function isBlockedIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return false;
}

/**
 * The hostname half of the structural check, shared with the browser's
 * egress proxy (which sees bare `host:port` CONNECT targets, never a URL).
 * Throws BlockedUrlError for the localhost family and for IP literals in
 * private/reserved ranges; a bracketed IPv6 literal is unwrapped first.
 */
export function assertSafeHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw new BlockedUrlError('host is not allowed');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new BlockedUrlError('host is not allowed');
  }
  if (net.isIP(host) && isBlockedIP(host)) {
    throw new BlockedUrlError('host resolves to a private or reserved address');
  }
}

/**
 * Structural, DNS-free checks. Throws BlockedUrlError on violation, otherwise
 * returns the parsed URL. Rejects non-https schemes, the localhost family, and
 * IP-literal hosts in private/reserved ranges.
 */
export function assertSafeHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('URL is not valid');
  }
  if (url.protocol !== 'https:') {
    throw new BlockedUrlError('only https URLs are allowed');
  }
  assertSafeHostname(url.hostname);
  return url;
}

/**
 * The structural checks plus a DNS resolution: every resolved address must be
 * public. A DNS failure is a refusal, not a pass-through — "could not
 * resolve" names the cause so a genuine outage reads as one.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = assertSafeHttpsUrl(raw);
  await resolvePublicAddress(url.hostname);
  return url;
}

/**
 * Resolve a hostname to the one public address a request will dial, or
 * throw BlockedUrlError: structural hostname rules first (which also settle
 * IP literals without touching DNS), then a lookup whose every answer must
 * be public. Refusing on ANY private answer, rather than picking a public
 * one, is deliberate — a name that resolves both ways is a rebinding setup,
 * not a host to reach. A name with no answer is refused the same way.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
  assertSafeHostname(hostname);
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(bare)) return bare;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    throw new BlockedUrlError(`could not resolve ${bare}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`could not resolve ${bare}`);
  for (const { address } of addresses) {
    if (isBlockedIP(address)) {
      throw new BlockedUrlError('host resolves to a private or reserved address');
    }
  }
  return addresses[0].address;
}
