/**
 * Body parsers for the ADManager Plus routes — validation lives here, not
 * in the UI, so the API is safe whatever client speaks to it. The base
 * URL is normalized server-side for the same reason: the UI's hint is a
 * convenience, never the check.
 */

import {
  DEFAULT_ADMANAGER_PERMISSIONS,
  isEnvironmentLabel,
  isAdManagerPermission,
  isTemplateName,
  MAX_TEMPLATE_NAME_LENGTH,
  normalizePermissions,
  parseBaseUrl,
} from '@renkei/connector-admanager';
import type {
  AdManagerCredentials,
  AdManagerPermission,
  InstanceInput,
} from '@renkei/connector-admanager';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A PEM bundle is one or more CERTIFICATE blocks; anything else is refused. */
function isPemBundle(value: string): boolean {
  return /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(value);
}

/** The admin instance form: connection details only — never a credential. */
export function parseInstancePayload(body: unknown): { input: InstanceInput } | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };

  const name = cleanString(body.name);
  if (!name || name.length > 120) return { error: 'name is required (max 120 chars)' };

  const environment = cleanString(body.environment) || 'prod';
  if (!isEnvironmentLabel(environment)) {
    return { error: 'environment must be a short label (letters, digits, spaces, . _ -)' };
  }

  const allowInsecureHttp = body.allowInsecureHttp === true;
  const baseUrl = parseBaseUrl(cleanString(body.baseUrl), allowInsecureHttp);
  if (!baseUrl) {
    return {
      error: allowInsecureHttp
        ? 'baseUrl must be an http(s) URL with no credentials, query or fragment'
        : 'baseUrl must be an https URL (tick "allow insecure HTTP" for a plaintext lab server)',
    };
  }

  const tlsVerify = body.tlsVerify !== false;

  // Absent keeps the stored CA; an empty string clears it; text must be PEM.
  let caPem: string | null | undefined;
  if (body.caPem === undefined) caPem = undefined;
  else if (body.caPem === null || cleanString(body.caPem) === '') caPem = null;
  else {
    const pem = cleanString(body.caPem);
    if (pem.length > 65_536 || !isPemBundle(pem)) {
      return { error: 'caPem must be one or more PEM CERTIFICATE blocks' };
    }
    caPem = pem;
  }

  // Absent, null or blank all mean "no template": the reset tool can then
  // reset a password but never force a change at next logon. Text must be
  // a plain one-line name — it is sent to ADManager Plus verbatim.
  const templateText = cleanString(body.resetPasswordTemplateName);
  if (templateText && !isTemplateName(templateText)) {
    return {
      error: `resetPasswordTemplateName must be a one-line template name (max ${MAX_TEMPLATE_NAME_LENGTH} chars)`,
    };
  }
  const resetPasswordTemplateName = templateText || null;

  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  return {
    input: {
      name,
      environment,
      baseUrl,
      tlsVerify,
      caPem,
      allowInsecureHttp,
      resetPasswordTemplateName,
      enabled,
    },
  };
}

export interface ParsedExposure {
  permissions: AdManagerPermission[];
}

/**
 * The LLM-exposure half of a connect or update body: the permission ids
 * the person ticked. An unknown id is an error rather than silently
 * dropped (a typo must not become "less than I asked for"); an absent
 * list on connect means the read-only default.
 */
export function parseExposurePayload(
  body: unknown,
  options: { defaultToReads?: boolean } = {}
): ParsedExposure | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };
  if (body.permissions === undefined) {
    if (options.defaultToReads) return { permissions: [...DEFAULT_ADMANAGER_PERMISSIONS] };
    return { error: 'permissions is required (a list of permission ids)' };
  }
  if (!Array.isArray(body.permissions)) return { error: 'permissions must be a list of ids' };
  const unknown = body.permissions.filter((value) => !isAdManagerPermission(value));
  if (unknown.length) return { error: `Unknown permission: ${unknown.map(String).join(', ')}` };
  return { permissions: normalizePermissions(body.permissions) };
}

export interface ParsedConnect extends ParsedExposure {
  credentials: AdManagerCredentials;
  technicianName: string;
}

/**
 * The connect form: the person's own ADManager Plus authtoken for one
 * instance, a self-reported technician name (ADManager Plus's REST API
 * has no "who am I" endpoint to echo one back — see
 * docs/admanager-connector-design.md), plus their exposure choice. A
 * missing token or name is an error, never a guess.
 */
export function parseConnectPayload(body: unknown): ParsedConnect | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };

  const exposure = parseExposurePayload(body, { defaultToReads: true });
  if ('error' in exposure) return exposure;

  const authToken = cleanString(body.authToken);
  if (!authToken) return { error: 'An authtoken is required' };

  const technicianName = cleanString(body.technicianName);
  if (!technicianName || technicianName.length > 255) {
    return { error: 'A technician name is required (max 255 chars)' };
  }

  return { ...exposure, credentials: { authToken }, technicianName };
}
