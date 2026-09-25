'use client';

import { FormEvent, useEffect, useState } from 'react';
import { GITHUB_SCOPE_OPTIONS, GITHUB_SCOPE_GROUPS } from '@/lib/github-scopes';
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
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

interface GitHubConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  appSlug: string | null;
  scopes: string | null;
  redirectUri: string | null;
  hasClientSecret: boolean;
  hasWebhookSecret: boolean;
}

/**
 * Org-admin setup for Renkei's GitHub App — the Bitbucket connector's
 * shape (client id/secret, a scope ceiling, a redirect override), plus
 * `appSlug` so the form can show the App's own install/settings link. A
 * GitHub App's real permissions live on the App's registration itself,
 * not on anything this form sends — the scope picker below is Renkei's
 * own capability ceiling (github-scopes.ts), never sent to GitHub.
 */
export function GitHubForm({ slug, origin }: { slug: string; origin: string | null }) {
  const url = `/api/admin/${slug}/connectors/github`;
  const [state, reload] = useConnectorConfig<GitHubConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [appSlug, setAppSlug] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () =>
      new Set(
        GITHUB_SCOPE_OPTIONS.filter((option) => option.defaultChecked).map((option) => option.id)
      )
  );
  const [redirectUri, setRedirectUri] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    setAppSlug(state.data.appSlug ?? '');
    if (state.data.configured && state.data.scopes) {
      const stored = new Set(state.data.scopes.split(/\s+/));
      const matching = GITHUB_SCOPE_OPTIONS.filter((option) => optionWithin(option, stored));
      if (matching.length > 0) setCheckedIds(new Set(matching.map((option) => option.id)));
    }
    setRedirectUri(state.data.redirectUri ?? '');
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
    const scopes = scopesOfOptions(GITHUB_SCOPE_OPTIONS, checkedIds).join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      enabled,
      scopes,
      ...(appSlug.trim() ? { appSlug: appSlug.trim() } : {}),
      ...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setClientSecret('');
    setWebhookSecret('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="GitHub" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="GitHub" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="GitHub"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        A GitHub App from{' '}
        <a
          href="https://github.com/settings/apps"
          className="text-blue-600 hover:underline dark:text-blue-400"
          target="_blank"
          rel="noreferrer"
        >
          github.com/settings/apps
        </a>{' '}
        (or your organization&apos;s own Developer settings). Its &quot;Callback URL&quot; must be{' '}
        <CallbackUrl origin={origin} />, with &quot;Request user authorization (OAuth) during
        installation&quot; checked — that is what lets one Connect click both install the App on an
        org/repos and authorize a person, the same as every other connector here. Grant it the
        repository contents, pull requests, actions, and metadata permissions your organization
        wants to offer below.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="github-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="github-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="github-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="github-client-secret"
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
        <div>
          <label htmlFor="github-app-slug" className={labelClass}>
            App slug <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="github-app-slug"
            value={appSlug}
            onChange={(e) => setAppSlug(e.target.value)}
            placeholder="your-app-name, from github.com/apps/your-app-name"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Only used to link people to the App&apos;s own install page when they need to add more
            repositories.
          </p>
        </div>
        <div>
          <label htmlFor="github-webhook-secret" className={labelClass}>
            Webhook secret <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="github-webhook-secret"
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={config?.hasWebhookSecret ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasWebhookSecret ? (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          ) : (
            <p className={hintClass}>
              Set this to the same value as the App&apos;s own Webhook secret to turn on pull
              request pipeline subscriptions — without it, deliveries to{' '}
              <code className="font-mono">/api/webhooks/github/&lt;tenant id&gt;</code> are
              refused.
            </p>
          )}
        </div>
        <div>
          <fieldset>
            <legend className={labelClass}>What users may grant</legend>
            <ScopePicker
              groups={GITHUB_SCOPE_GROUPS}
              options={GITHUB_SCOPE_OPTIONS}
              checked={checkedIds}
              onToggle={toggleOption}
            />
            <p className={hintClass}>
              This is the ceiling: users can narrow it when they connect, never widen it. Unlike
              Jira/Confluence, a GitHub App&apos;s real permissions are fixed on the App&apos;s own
              registration and are never requested here — checking a capability only decides what
              Renkei USES from the App&apos;s permissions, not what GitHub grants. Users who already
              connected keep their old choices until they reconnect.
            </p>
          </fieldset>
        </div>
        <div>
          <label htmlFor="github-redirect" className={labelClass}>
            Redirect URI override <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="github-redirect"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="Defaults to this origin + /api/oauth/callback"
            className={`${inputClass} font-mono`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
