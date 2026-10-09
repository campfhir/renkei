/**
 * The browser-safe half of lib/insecure-transport.ts: which protections a
 * saved configuration has switched off, and whether an environment label
 * names production. Client components (the instance and connector admin
 * forms) import THIS for their banners; the DNS-backed verdict that gates
 * a save lives beside it on the server only.
 */

export type InsecureTransportMode = 'tls_verify_off' | 'plaintext_http';

export const INSECURE_MODE_LABELS: Record<InsecureTransportMode, string> = {
  tls_verify_off: 'certificate verification off',
  plaintext_http: 'plaintext HTTP allowed',
};

/** Which insecure settings a saved configuration carries, if any. */
export function insecureTransportModes(input: {
  tlsVerify?: boolean;
  allowInsecureHttp?: boolean;
}): InsecureTransportMode[] {
  const modes: InsecureTransportMode[] = [];
  if (input.tlsVerify === false) modes.push('tls_verify_off');
  if (input.allowInsecureHttp === true) modes.push('plaintext_http');
  return modes;
}

/**
 * Whether an environment label names production. Mirth and ADManager
 * instances carry a free label (`prod`, `test`, `site-a`…), defaulting to
 * `prod`; the production spellings are matched as whole words so `prod`,
 * `production`, `prd`, `us-prod` and `PROD 2` all count and `preprod` or
 * `product-test` do not.
 */
export function isProductionLabel(environment: string): boolean {
  return /(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/i.test(environment.trim());
}
