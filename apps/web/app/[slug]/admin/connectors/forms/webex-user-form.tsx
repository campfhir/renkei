'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  WEBEX_USER_SCOPE_OPTIONS,
  WEBEX_SCOPE_GROUPS,
  WEBEX_REQUIRED_SCOPES,
} from '@/lib/webex-scopes';
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

/* ----------------------------------------------------------------------- */

interface WebexUserConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

export function WebexUserForm({ slug, origin }: { slug: string; origin: string | null }) {
  const url = `/api/admin/${slug}/connectors/webex-user`;
  const [state, reload] = useConnectorConfig<WebexUserConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // Checked scopes, spark:kms excluded — it is always sent, never a choice.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(WEBEX_USER_SCOPE_OPTIONS.map((option) => option.id))
  );
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    if (state.data.configured && state.data.scopes) {
      const stored = new Set(state.data.scopes.split(/\s+/));
      const matching = WEBEX_USER_SCOPE_OPTIONS.filter((option) => optionWithin(option, stored));
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
      ...scopesOfOptions(WEBEX_USER_SCOPE_OPTIONS, checkedIds),
      ...WEBEX_REQUIRED_SCOPES,
    ].join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
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
      <Card title="WebEx (user access)" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="WebEx (user access)" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="WebEx (user access)"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        An{' '}
        <a
          href="https://developer.webex.com/my-apps"
          className="text-blue-600 hover:underline dark:text-blue-400"
          target="_blank"
          rel="noreferrer"
        >
          Integration
        </a>{' '}
        (not the bot) through which each person grants Renkei read access to their own WebEx — rooms
        they are in, messages they can see. Its redirect URI must be <CallbackUrl origin={origin} />
        .
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="wxu-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="wxu-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="wxu-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="wxu-client-secret"
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
            groups={WEBEX_SCOPE_GROUPS}
            options={WEBEX_USER_SCOPE_OPTIONS}
            checked={checkedIds}
            onToggle={toggleOption}
          />
          <p className={hintClass}>
            This is the ceiling: users can narrow it when they connect, never widen it. Every
            checked scope must also be selected on the Integration at developer.webex.com — WebEx
            refuses the authorize step otherwise.{' '}
            <code className="font-mono text-xs">{WEBEX_REQUIRED_SCOPES.join(' ')}</code> are always
            included (identifying who granted, and decrypting message content). Users who already
            connected keep their old scopes until they reconnect.
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
