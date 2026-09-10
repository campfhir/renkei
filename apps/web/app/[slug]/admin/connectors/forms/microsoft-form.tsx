'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  MICROSOFT_SCOPE_GROUPS,
  MICROSOFT_SCOPE_OPTIONS,
  MICROSOFT_REQUIRED_SCOPES,
} from '@/lib/microsoft-scopes';
import ScopePicker from '@/components/scope-picker';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  CallbackUrl,
  inputClass,
  labelClass,
  hintClass,
  SaveRow,
} from './shared';

/* ----------------------------------------------------------------------- */

interface MicrosoftConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  directoryTenantId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

export function MicrosoftForm({ slug, origin }: { slug: string; origin: string | null }) {
  const url = `/api/admin/${slug}/connectors/microsoft`;
  const [state, reload] = useConnectorConfig<MicrosoftConfig>(url);
  const [clientId, setClientId] = useState('');
  const [directoryTenantId, setDirectoryTenantId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // Checked scopes, openid/profile/email/offline_access/User.Read excluded —
  // they are always sent, never a choice.
  // Honour defaultChecked like the Atlassian form does. Seeding every option
  // instead would silently pre-check scopes the Entra app has not been
  // granted — and Microsoft rejects the whole consent when one is missing,
  // so a new capability would break connecting rather than merely not work.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () =>
      new Set(MICROSOFT_SCOPE_OPTIONS.filter((option) => option.defaultChecked).map((o) => o.id))
  );
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    setDirectoryTenantId(state.data.directoryTenantId ?? '');
    if (state.data.configured && state.data.scopes) {
      const stored = new Set(state.data.scopes.split(/\s+/));
      const matching = MICROSOFT_SCOPE_OPTIONS.filter((option) => optionWithin(option, stored));
      if (matching.length > 0) setCheckedIds(new Set(matching.map((option) => option.id)));
    }
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  function toggleOption(optionId: string, on: boolean) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (on) next.add(optionId);
      else next.delete(optionId);
      return next;
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const scopes = [
      ...scopesOfOptions(MICROSOFT_SCOPE_OPTIONS, checkedIds),
      ...MICROSOFT_REQUIRED_SCOPES,
    ].join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      directoryTenantId: directoryTenantId.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      enabled,
      scopes,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setClientSecret('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Microsoft 365" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Microsoft 365" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Microsoft 365"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        An{' '}
        <a
          href="https://entra.microsoft.com"
          className="text-blue-600 hover:underline dark:text-blue-400"
          target="_blank"
          rel="noreferrer"
        >
          Entra app registration
        </a>{' '}
        through which each person grants Renkei read access to their own Microsoft 365 — Outlook
        mail, calendar, To&nbsp;Do tasks. Register a <strong>Web</strong> platform whose redirect
        URI is <CallbackUrl origin={origin} />, and grant the app delegated Microsoft Graph
        permissions matching the ceiling below.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="ms-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="ms-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="ms-directory-id" className={labelClass}>
            Directory (tenant) ID
          </label>
          <input
            id="ms-directory-id"
            required
            value={directoryTenantId}
            onChange={(e) => setDirectoryTenantId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            The Entra directory GUID from the app registration&apos;s Overview page — not{' '}
            <code className="font-mono text-xs">common</code>; Renkei authorizes against your
            directory alone.
          </p>
        </div>
        <div>
          <label htmlFor="ms-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="ms-client-secret"
            type="password"
            required={!config?.hasClientSecret}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={config?.hasClientSecret ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <fieldset>
          <legend className={labelClass}>What users may grant</legend>
          <ScopePicker
            groups={MICROSOFT_SCOPE_GROUPS}
            options={MICROSOFT_SCOPE_OPTIONS}
            checked={checkedIds}
            onToggle={toggleOption}
          />
          <p className={hintClass}>
            This is the ceiling: users can narrow it when they connect, never widen it. Every
            checked capability must also be added to the app registration as delegated Microsoft
            Graph permissions — Microsoft refuses the authorize step otherwise.{' '}
            <code className="font-mono text-xs">{MICROSOFT_REQUIRED_SCOPES.join(' ')}</code> are
            always included (identifying who granted, and keeping the grant refreshable). Users who
            already connected keep their old scopes until they reconnect.
          </p>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
