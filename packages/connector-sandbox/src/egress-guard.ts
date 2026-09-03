import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF guard for `sandbox_download_url` and the sandbox browser — every
 * sandbox operation that reaches a caller-supplied URL. This is the same
 * logic as apps/web/lib/safe-fetch.ts (used there for tenant-configured
 * OIDC discovery URLs) — duplicated rather than imported because a worker
 * process cannot depend on the Next.js app's `lib/`, and this package is
 * exactly the shared home connector-fileshares/connector-onbase use for
 * logic both the web app and a worker need. Keep the two in sync by hand;
 * see the comment there for the same caveats (DNS rebinding is not fully
 * closed by a resolve-then-connect check — the browser's egress proxy in
 * apps/worker-sandbox/src/browser-proxy.ts closes it by connecting to the
 * very address it verified).
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

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80')) return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
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
 * public. A DNS failure is left for the real request to surface — it must not
 * be treated as "safe" and it must not mask a genuine outage as an SSRF block.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = assertSafeHttpsUrl(raw);
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host)) return url; // already validated as a literal above

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return url;
  }
  for (const { address } of addresses) {
    if (isBlockedIP(address)) {
      throw new BlockedUrlError('host resolves to a private or reserved address');
    }
  }
  return url;
}
