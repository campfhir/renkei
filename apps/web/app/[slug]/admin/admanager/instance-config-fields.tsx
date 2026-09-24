'use client';

/**
 * The ADManager Plus instance config form fields, shared by the create
 * form (list page) and the edit form (detail page) so the two can never
 * drift. Pure controlled fields over an InstanceDraft — connection
 * details only: no credential ever appears on the admin surface, because
 * every person connects an instance with their own ADManager Plus
 * authtoken from the connectors page.
 */

import { useId } from 'react';
import { MAX_TEMPLATE_NAME_LENGTH, parseBaseUrl } from '@renkei/connector-admanager/pure';

export const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export interface InstanceDraft {
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  /** The PEM to store; empty keeps what is stored on edit and stores nothing on create. */
  caPem: string;
  /** Whether the edit form should clear a stored CA (an explicit choice). */
  clearCa: boolean;
  hasCustomCa: boolean;
  allowInsecureHttp: boolean;
  /** The ADManager Plus template the reset-password tool applies; empty means none. */
  resetPasswordTemplateName: string;
  enabled: boolean;
}

export function emptyDraft(): InstanceDraft {
  return {
    name: '',
    environment: 'prod',
    baseUrl: '',
    tlsVerify: true,
    caPem: '',
    clearCa: false,
    hasCustomCa: false,
    allowInsecureHttp: false,
    resetPasswordTemplateName: '',
    enabled: true,
  };
}

/** What the admin routes accept. */
export function draftPayload(draft: InstanceDraft): Record<string, unknown> {
  return {
    name: draft.name,
    environment: draft.environment,
    baseUrl: draft.baseUrl,
    tlsVerify: draft.tlsVerify,
    // Absent keeps the stored CA; null clears it; text replaces it.
    ...(draft.clearCa ? { caPem: null } : draft.caPem.trim() ? { caPem: draft.caPem } : {}),
    allowInsecureHttp: draft.allowInsecureHttp,
    // Blank is sent as null so an edit can clear a stored template.
    resetPasswordTemplateName: draft.resetPasswordTemplateName.trim() || null,
    enabled: draft.enabled,
  };
}

/** The live normalization the server will apply to the URL. */
export function urlPreview(draft: InstanceDraft): { text: string; error: boolean } {
  if (!draft.baseUrl.trim())
    return { text: 'The REST API is reached at <server URL>/api/v1 and /api/v2.', error: false };
  const parsed = parseBaseUrl(draft.baseUrl, draft.allowInsecureHttp);
  if (!parsed) {
    return {
      text: draft.allowInsecureHttp
        ? 'Not a usable URL (no credentials, query or fragment).'
        : 'Must be an https URL — or allow insecure HTTP below for a plaintext lab server.',
      error: true,
    };
  }
  return { text: `REST API at ${parsed}/api/v1 and ${parsed}/api/v2`, error: false };
}

export default function InstanceConfigFields({
  draft,
  onChange,
}: {
  draft: InstanceDraft;
  onChange: (draft: InstanceDraft) => void;
}) {
  const set = (patch: Partial<InstanceDraft>) => onChange({ ...draft, ...patch });
  const preview = urlPreview(draft);
  // The template help is a description, not part of the field's name —
  // kept outside the <label> so the accessible name stays the short
  // label (and no other field's label is a substring of this help text).
  const templateHelpId = useId();

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Name
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.name}
            placeholder="e.g. ADManager Plus production"
            onChange={(event) => set({ name: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Environment
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.environment}
            placeholder="dev, test, prod, site-a…"
            onChange={(event) => set({ environment: event.target.value })}
          />
          <span className="mt-1 block text-xs font-normal text-gray-500 dark:text-gray-400">
            A label the tools show so an assistant can tell instances apart.
          </span>
        </label>
        <label className="block text-sm font-medium sm:col-span-2">
          Server URL
          <input
            className={`${inputClass} mt-1 block w-full font-mono`}
            value={draft.baseUrl}
            placeholder="https://admanagerplus.corp.example:8080"
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
          <span
            className={`mt-1 block text-xs font-normal ${preview.error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {preview.text}
          </span>
        </label>
      </div>

      <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <p className="text-sm font-medium">TLS</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.tlsVerify}
            onChange={(event) => set({ tlsVerify: event.target.checked })}
          />
          Verify the server certificate
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          ADManager Plus often ships behind a self-signed or internal-CA certificate. Prefer
          pasting your internal CA below and keeping verification on; switching it off is
          recorded as your decision for this instance.
        </p>
        <label className="block text-sm font-medium">
          Internal CA certificate (PEM, optional)
          <textarea
            className={`${inputClass} mt-1 block h-24 w-full font-mono text-xs`}
            placeholder={
              draft.hasCustomCa && !draft.clearCa
                ? 'A CA certificate is stored — paste a new one to replace it'
                : '-----BEGIN CERTIFICATE-----'
            }
            value={draft.caPem}
            onChange={(event) => set({ caPem: event.target.value, clearCa: false })}
          />
        </label>
        {draft.hasCustomCa ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.clearCa}
              onChange={(event) => set({ clearCa: event.target.checked, caPem: '' })}
            />
            Remove the stored CA certificate
          </label>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.allowInsecureHttp}
            onChange={(event) => set({ allowInsecureHttp: event.target.checked })}
          />
          Allow insecure HTTP (plaintext — lab servers only; authtokens travel unencrypted)
        </label>
      </div>

      <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <p className="text-sm font-medium">Password resets</p>
        <label className="block text-sm font-medium">
          Reset-password template (optional)
          <input
            className={`${inputClass} mt-1 block w-full`}
            value={draft.resetPasswordTemplateName}
            placeholder="e.g. Reset Password – must change at next logon"
            maxLength={MAX_TEMPLATE_NAME_LENGTH}
            aria-describedby={templateHelpId}
            onChange={(event) => set({ resetPasswordTemplateName: event.target.value })}
          />
        </label>
        <p id={templateHelpId} className="text-xs text-gray-500 dark:text-gray-400">
          The exact name of a user-modification template on this ADManager Plus server with
          &ldquo;User must change password at next logon&rdquo; set. The REST API cannot set that
          flag directly, so after resetting a password the tools apply this template to force the
          change. Leave blank and password resets can still run, but never force a change at next
          logon.
        </p>
      </div>
    </div>
  );
}
