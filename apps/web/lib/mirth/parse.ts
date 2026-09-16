/**
 * Body parsers for the Mirth routes — validation lives here, not in the
 * UI, so the API is safe whatever client speaks to it. The base URL is
 * normalized server-side for the same reason: the UI's hint is a
 * convenience, never the check.
 */

import { isEnvironmentLabel, isToolAccess, parseBaseUrl } from '@renkei/connector-mirth';
import type { InstanceInput, MirthCredentials, ToolAccess } from '@renkei/connector-mirth';

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

  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  return {
    input: { name, environment, baseUrl, tlsVerify, caPem, allowInsecureHttp, enabled },
  };
}

export interface ParsedExposure {
  toolAccess: ToolAccess;
  allowDestructive: boolean;
}

/**
 * The LLM-exposure half of a connect or update body. Destructive without
 * write would be a lie on the card — the destructive tools require
 * read/write — so it is normalized away rather than stored.
 */
export function parseExposurePayload(body: unknown): ParsedExposure | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };
  const toolAccess = body.toolAccess;
  if (!isToolAccess(toolAccess)) {
    return { error: "toolAccess must be 'read' or 'read_write'" };
  }
  const allowDestructive = body.allowDestructive === true && toolAccess === 'read_write';
  return { toolAccess, allowDestructive };
}

export interface ParsedConnect extends ParsedExposure {
  credentials: MirthCredentials;
}

/**
 * The connect form: the person's own Mirth credential for one instance,
 * plus their exposure choice. A partial credential is an error, never a
 * guess.
 */
export function parseConnectPayload(body: unknown): ParsedConnect | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };

  const exposure = parseExposurePayload(body);
  if ('error' in exposure) return exposure;

  const username = cleanString(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username) return { error: 'A credential needs a username' };
  if (!password) return { error: 'A credential needs a password' };

  return { ...exposure, credentials: { username, password } };
}
