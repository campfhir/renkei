'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  ENTRA_DEVELOPER_SCOPE_GROUPS,
  ENTRA_DEVELOPER_SCOPE_OPTIONS,
  ENTRA_DEVELOPER_REQUIRED_SCOPES,
} from '@/lib/entra-developer-scopes';
import ScopePicker from '@/components/scope-picker';
import ExternalLink from '@/components/external-link';
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
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

/* ----------------------------------------------------------------------- */

interface EntraDeveloperConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  directoryTenantId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

/**
 * The Entra Developer app registration — the microsoft-form.tsx shape for
 * the SECOND Entra app: application provisioning permissions on a
 * registration of their own, so an org can hand them to its developers
 * without widening anyone's Microsoft 365 consent.
 */
export function EntraDeveloperForm({ slug, origin }: { slug: string; origin: string | null }) {
  const url = `/api/admin/${slug}/connectors/entra-developer`;
  const [state, reload] = useConnectorConfig<EntraDeveloperConfig>(url);
  const [clientId, setClientId] = useState('');
  const [directoryTenantId, setDirectoryTenantId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () =>
      new Set(
        ENTRA_DEVELOPER_SCOPE_OPTIONS.filter((option) => option.defaultChecked).map((o) => o.id)
      )
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
      const matching = ENTRA_DEVELOPER_SCOPE_OPTIONS.filter((option) =>
        optionWithin(option, stored)
      );
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
      ...new Set([
        ...scopesOfOptions(ENTRA_DEVELOPER_SCOPE_OPTIONS, checkedIds),
        ...ENTRA_DEVELOPER_REQUIRED_SCOPES,
      ]),
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
      <Card title="Entra Developer" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Entra Developer" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Entra Developer"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        A <strong>separate</strong>{' '}
        <ExternalLink
          href="https://entra.microsoft.com"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Entra app registration
        </ExternalLink>{' '}
        from the Microsoft 365 one, through which a developer lets Renkei provision applications as
        them: app registrations, enterprise applications, app roles, and which users and groups hold
        each role. Register a <strong>Web</strong> platform whose redirect URI is{' '}
        <CallbackUrl origin={origin} />, grant the app the delegated Microsoft Graph permissions
        matching the ceiling below, and have an Entra admin consent to them — they are
        directory-wide, which is why they live on an app of their own. Entra still applies its own
        rules on every call: who may create applications, and who owns an existing one.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="entra-dev-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="entra-dev-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="entra-dev-directory-id" className={labelClass}>
            Directory (tenant) ID
          </label>
          <input
            id="entra-dev-directory-id"
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
          <label htmlFor="entra-dev-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="entra-dev-client-secret"
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
            groups={ENTRA_DEVELOPER_SCOPE_GROUPS}
            options={ENTRA_DEVELOPER_SCOPE_OPTIONS}
            checked={checkedIds}
            onToggle={toggleOption}
          />
          <p className={hintClass}>
            This is the ceiling: users can narrow it when they connect, never widen it. Every
            checked capability must also be added to the app registration as delegated Microsoft
            Graph permissions, with admin consent granted — Microsoft refuses the authorize step
            otherwise.{' '}
            <code className="font-mono text-xs">{ENTRA_DEVELOPER_REQUIRED_SCOPES.join(' ')}</code>{' '}
            are always included (identifying who granted, and keeping the grant refreshable). Users
            who already connected keep their old scopes until they reconnect.
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
