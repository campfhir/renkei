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
import { MAX_TEMPLATE_NAME_LENGTH } from '@renkei/connector-admanager/pure';
import { caPlaceholder, urlPreview, type InstanceDraft } from './instance-list.model';

export const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function InstanceConfigFields({
  draft,
  onChange,
}: {
  draft: InstanceDraft;
  /** A change to the draft; the model's editDraft applies it. */
  onChange: (patch: Partial<InstanceDraft>) => void;
}) {
  const set = onChange;
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
          ADManager Plus often ships behind a self-signed or internal-CA certificate. Prefer pasting
          your internal CA below and keeping verification on; switching it off is recorded as your
          decision for this instance.
        </p>
        <label className="block text-sm font-medium">
          Internal CA certificate (PEM, optional)
          <textarea
            className={`${inputClass} mt-1 block h-24 w-full font-mono text-xs`}
            placeholder={caPlaceholder(draft)}
            value={draft.caPem}
            onChange={(event) => set({ caPem: event.target.value })}
          />
        </label>
        {draft.hasCustomCa ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.clearCa}
              onChange={(event) => set({ clearCa: event.target.checked })}
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
