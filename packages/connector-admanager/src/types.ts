/**
 * The domain vocabulary for ManageEngine ADManager Plus instances.
 *
 * Renkei holds no authorization model of its own beyond the named
 * permissions below: an operator registers WHERE each ADManager Plus
 * server is (an org may run more than one — per domain, per site, or a
 * separate test instance), every person connects each one with their OWN
 * ADManager Plus authtoken, and ADManager Plus's own scope on that token
 * plus the technician's delegated rights decide what the account may do
 * on every call. What Renkei keeps is the person's LLM-exposure choice: a
 * narrowing of what the MCP tools may attempt with a credential the
 * person already holds, never a widening. See
 * docs/admanager-connector-design.md.
 */

import type { AdManagerPermission } from './permissions';

/** An instance as operators register it — connection details only, no credentials. */
export interface AdManagerInstanceSummary {
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
  /**
   * The ADManager Plus template the reset-password tool applies to force
   * "must change password at next logon" — an instance setting an
   * operator records, because the template is defined in that server's
   * own configuration and the tools must use its exact name (see
   * `readInstanceSettings`). Null when none is configured, in which case
   * the tool can reset a password but never force a change.
   */
  resetPasswordTemplateName: string | null;
  enabled: boolean;
}

/**
 * The typed view of an instance row's `settings` JSON — the operator
 * choices that are neither connection details nor credentials. Reading
 * is lenient (an unknown or malformed key is simply absent) so an old
 * row never poisons a read; writing goes through `parse.ts`'s checks.
 */
export interface AdManagerInstanceSettings {
  resetPasswordTemplateName: string | null;
}

/** Template names are what ADManager Plus shows in its own UI: short, plain text. */
export const MAX_TEMPLATE_NAME_LENGTH = 255;

export function isTemplateName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim() === value &&
    value.length <= MAX_TEMPLATE_NAME_LENGTH &&
    !/[\r\n\t]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readInstanceSettings(settings: unknown): AdManagerInstanceSettings {
  const template = isRecord(settings) ? settings.resetPasswordTemplateName : undefined;
  return {
    resetPasswordTemplateName: isTemplateName(template) ? template : null,
  };
}

/** One person's connection to one instance (credentials stored separately). */
export interface InstanceConnection {
  /** The ADManager Plus technician name the token belongs to — display only, no secret. */
  technicianName: string;
  /** What the LLM tools may attempt here — see permissions.ts. */
  permissions: AdManagerPermission[];
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
