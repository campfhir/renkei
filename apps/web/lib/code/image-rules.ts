/**
 * The organization's service image allow-list, as the admin console
 * reads and writes it: every call goes to the sandbox worker
 * (`services/rules/*`), which owns the rows and seals a registry
 * credential under its own key — so a secret an operator types passes
 * through this app once, on the way in, and is never read back here.
 * The pattern is normalized by the worker (`normalizeImageRule`); this
 * module only checks the payload's shape and bounds before handing it on.
 */

import {
  IMAGE_REFERENCE_MAX_CHARS,
  IMAGE_RULE_NOTE_MAX_CHARS,
  IMAGE_RULE_SECRET_MAX_CHARS,
  IMAGE_RULE_USERNAME_MAX_CHARS,
} from '@renkei/connector-sandbox';

export interface ImageRulePayload {
  pattern: string;
  note: string | null;
  registryUsername?: string;
  registrySecret?: string;
  clearCredential?: boolean;
}

export function parseImageRulePayload(body: unknown): ImageRulePayload | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: {
    pattern?: unknown;
    note?: unknown;
    registryUsername?: unknown;
    registrySecret?: unknown;
    clearCredential?: unknown;
  } = body;
  const pattern = typeof record.pattern === 'string' ? record.pattern.trim() : '';
  if (!pattern || pattern.length > IMAGE_REFERENCE_MAX_CHARS) {
    return { error: `pattern is required (at most ${IMAGE_REFERENCE_MAX_CHARS} characters)` };
  }
  const note =
    typeof record.note === 'string' && record.note.trim()
      ? record.note.trim().slice(0, IMAGE_RULE_NOTE_MAX_CHARS)
      : null;
  const username =
    typeof record.registryUsername === 'string' ? record.registryUsername.trim() : '';
  const secret = typeof record.registrySecret === 'string' ? record.registrySecret : '';
  if ((username && !secret) || (!username && secret)) {
    return { error: 'A registry credential is a username and a secret together' };
  }
  if (username.length > IMAGE_RULE_USERNAME_MAX_CHARS) {
    return { error: `registryUsername is at most ${IMAGE_RULE_USERNAME_MAX_CHARS} characters` };
  }
  if (secret.length > IMAGE_RULE_SECRET_MAX_CHARS) {
    return { error: `registrySecret is at most ${IMAGE_RULE_SECRET_MAX_CHARS} characters` };
  }
  return {
    pattern,
    note,
    ...(username ? { registryUsername: username, registrySecret: secret } : {}),
    ...(record.clearCredential === true ? { clearCredential: true } : {}),
  };
}
