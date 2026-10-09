/**
 * The one rule for an admin switching transport security OFF on a
 * connector instance — Mirth, ADManager Plus and OnBase all let an operator
 * save `tlsVerify: false` (accept any certificate) or `allowInsecureHttp:
 * true` (bearer tokens and passwords in plaintext) for a lab server:
 *
 *  - a PRODUCTION instance never gets either: https with a verified
 *    certificate, or the save is refused;
 *  - otherwise the target host must resolve to a private network only
 *    (RFC 1918, loopback, link-local, CGNAT, IPv6 ULA — the egress guard's
 *    own notion of "not public", reused rather than re-listed): plaintext
 *    or an unverified certificate to a host on the public internet is an
 *    interception waiting to happen, whatever the label says. A name that
 *    does not resolve, or resolves to any public address, is refused;
 *  - every save that keeps an insecure mode on is an audit event
 *    (`<connector>.insecure_transport_enabled`), so the trail shows who
 *    accepted it and for which host.
 *
 * The admin pages show a persistent banner while either mode is on
 * (insecure-transport-modes.ts, the browser-safe half, feeds that).
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { isBlockedIP } from '@renkei/connector-sandbox';

export {
  INSECURE_MODE_LABELS,
  insecureTransportModes,
  isProductionLabel,
  type InsecureTransportMode,
} from './insecure-transport-modes';
import { INSECURE_MODE_LABELS, type InsecureTransportMode } from './insecure-transport-modes';

export interface InsecureTransportCheck {
  modes: InsecureTransportMode[];
  /** True refuses every insecure mode outright. */
  production: boolean;
  /** The URLs the instance will be dialled at; every host must be private. */
  urls: string[];
}

export type AddressLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: AddressLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^\[/, '').replace(/\]$/, '');
  } catch {
    return null;
  }
}

/**
 * The verdict on saving an instance with the given insecure modes. `ok`
 * with no modes is trivially allowed; otherwise production refuses, and
 * each host is resolved and every answer must be a private address.
 */
export async function checkInsecureTransport(
  input: InsecureTransportCheck,
  resolve: AddressLookup = defaultLookup
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.modes.length === 0) return { ok: true };
  const what = input.modes.map((mode) => INSECURE_MODE_LABELS[mode]).join(' and ');
  if (input.production) {
    return {
      ok: false,
      error: `A production instance must use https with certificate verification (${what} is not allowed). Turn the setting back on, or label the instance as a non-production environment if that is what it is.`,
    };
  }
  for (const raw of input.urls) {
    const host = hostOf(raw);
    if (!host) return { ok: false, error: `${raw} is not a usable URL.` };
    let addresses: string[];
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await resolve(host);
      } catch {
        addresses = [];
      }
      if (addresses.length === 0) {
        return {
          ok: false,
          error: `${what} is only allowed for a host on a private network, and ${host} could not be resolved to check that.`,
        };
      }
    }
    const publicAddress = addresses.find((address) => !isBlockedIP(address));
    if (publicAddress !== undefined) {
      return {
        ok: false,
        error: `${what} is only allowed for a host on a private network (RFC 1918, loopback, link-local or IPv6 unique-local); ${host} resolves to the public address ${publicAddress}.`,
      };
    }
  }
  return { ok: true };
}
