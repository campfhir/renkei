/**
 * The domain vocabulary for Mirth Connect (NextGen Connect, 4.5.2 — the
 * last open-source release) instances.
 *
 * Renkei holds NO authorization model of its own here, the file-share
 * discipline: an operator registers WHERE each Mirth server is (an org
 * usually runs several — dev, test, prod, one per site), every person
 * connects each one with their OWN Mirth username and password, and the
 * Mirth server's user roles and channel permissions decide what that
 * account may see or do on every call. What Renkei keeps is the person's
 * LLM-exposure choice (`ToolAccess` + destructive consent): a narrowing of
 * what the MCP tools may attempt with credentials the person already
 * holds, never a widening.
 */

import type { MirthPermission } from './permissions';

/** An instance as operators register it — connection details only, no credentials. */
export interface MirthInstanceSummary {
  id: string;
  name: string;
  /** A free-text label ('dev', 'prod', 'site-a') the tools show to tell instances apart. */
  environment: string;
  /** Origin plus optional path prefix, no trailing slash; the REST API is at `${baseUrl}/api`. */
  baseUrl: string;
  /** Whether the server's TLS certificate is verified. Off is an explicit operator decision. */
  tlsVerify: boolean;
  /** Whether an internal CA is pinned for this instance (the PEM itself is not in the summary). */
  hasCustomCa: boolean;
  allowInsecureHttp: boolean;
  enabled: boolean;
}

/** One person's connection to one instance (credentials stored separately). */
export interface InstanceConnection {
  /** The Mirth account the person connected with — display only, no secret. */
  username: string;
  /** What the LLM tools may attempt here — see permissions.ts. */
  permissions: MirthPermission[];
}

/** Environment labels are short, plain, and case-preserved. */
export const MAX_ENVIRONMENT_LENGTH = 40;

export function isEnvironmentLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ENVIRONMENT_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value)
  );
}
