/**
 * What an access token ACTUALLY carries, decoded from its own claims — the
 * source of truth for granted_scopes. A provider's token response and our
 * pending-flow record both describe intentions; only the minted token
 * describes the credential Atlassian's gateway evaluates.
 *
 * Decoding is unverified by design: this is our own outbound credential
 * being described, not untrusted input, and only scope names are extracted —
 * never the token or signature material.
 */
export function scopesFromAccessToken(accessToken: string): string[] | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null; // opaque token (WebEx): unknown, not empty

  let payload: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  // The conventional claims first — including Microsoft's `scp`, which the
  // substring scan below would miss — then any provider-prefixed variant
  // (Atlassian has used namespaced claim URIs before).
  const candidates = [
    payload.scope,
    payload.scopes,
    payload.scp,
    ...Object.entries(payload)
      .filter(([key]) => key.toLowerCase().includes('scope'))
      .map(([, value]) => value),
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim().split(/\s+/);
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value;
    }
  }
  return null;
}
