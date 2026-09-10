'use client';

import { FormEvent, ReactNode, useEffect, useState } from 'react';
import {
  ATLASSIAN_SCOPE_OPTIONS,
  ATLASSIAN_SCOPE_GROUPS,
  ATLASSIAN_JSM_SCOPE_OPTIONS,
  ATLASSIAN_JSM_SCOPE_GROUPS,
  ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
  ATLASSIAN_CONFLUENCE_SCOPE_GROUPS,
  ATLASSIAN_BITBUCKET_SCOPE_OPTIONS,
  ATLASSIAN_BITBUCKET_SCOPE_GROUPS,
  ATLASSIAN_OFFLINE_SCOPE,
  BITBUCKET_ACCOUNT_SCOPE,
} from '@/lib/atlassian-scopes';
import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
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

interface AtlassianConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  redirectUri: string | null;
  hasClientSecret: boolean;
}

export function AtlassianForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian"
      title="Atlassian (Jira)"
      groups={ATLASSIAN_SCOPE_GROUPS}
      options={ATLASSIAN_SCOPE_OPTIONS}
    />
  );
}

export function AtlassianJsmForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-jsm"
      title="Atlassian (Service Management & Ops)"
      groups={ATLASSIAN_JSM_SCOPE_GROUPS}
      options={ATLASSIAN_JSM_SCOPE_OPTIONS}
    />
  );
}

export function AtlassianConfluenceForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-confluence"
      title="Atlassian (Confluence)"
      groups={ATLASSIAN_CONFLUENCE_SCOPE_GROUPS}
      options={ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS}
    />
  );
}

export function AtlassianBitbucketForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-bitbucket"
      title="Atlassian (Bitbucket)"
      groups={ATLASSIAN_BITBUCKET_SCOPE_GROUPS}
      options={ATLASSIAN_BITBUCKET_SCOPE_OPTIONS}
      // No offline_access on Bitbucket — refresh tokens are always issued;
      // `account` rides instead, for the identity read at connect time.
      alwaysScope={BITBUCKET_ACCOUNT_SCOPE}
      intro={
        <>
          An OAuth consumer from your Bitbucket workspace&apos;s settings (Workspace settings →
          OAuth consumers). Its callback URL must be <CallbackUrl origin={origin} />, and it needs
          &quot;This is a private consumer&quot; checked.
        </>
      }
      scopeHint={
        <>
          This is the ceiling: users can narrow it when they connect, never widen it. Every checked
          scope must also be granted to the consumer on bitbucket.org — and unlike the other
          Atlassian apps, Bitbucket&apos;s consent screen always shows the consumer&apos;s full set:
          narrowing here decides what Renkei USES, not what the token carries.{' '}
          <code className="font-mono text-xs">{BITBUCKET_ACCOUNT_SCOPE}</code> is always included
          (it is how Renkei learns whose grant it stored). Users who already connected keep their
          old choices until they reconnect.
        </>
      }
    />
  );
}

/**
 * One form serves all three Atlassian app registrations — Jira, "Renkei JSM"
 * (the split exists because Atlassian's all-of scope enforcement times its
 * consent-URL length cliff makes the combined scope union unfittable on one
 * app). Each connector stores its own client id/secret and scope ceiling.
 */
function AtlassianAppForm({
  slug,
  origin,
  connector,
  title,
  groups,
  options,
  alwaysScope = ATLASSIAN_OFFLINE_SCOPE,
  intro,
  scopeHint,
}: {
  slug: string;
  origin: string | null;
  connector: string;
  title: string;
  groups: ScopeGroup[];
  options: ScopeOption[];
  /** The scope appended to every save, never offered as a checkbox. */
  alwaysScope?: string;
  /** Replaces the developer.atlassian.com blurb for non-3LO apps. */
  intro?: ReactNode;
  /** Replaces the default ceiling hint under the scope picker. */
  scopeHint?: ReactNode;
}) {
  const url = `/api/admin/${slug}/connectors/${connector}`;
  const [state, reload] = useConnectorConfig<AtlassianConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // Checked capability bundles, offline_access excluded — it is always sent,
  // never a choice.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(options.filter((option) => option.defaultChecked).map((option) => option.id))
  );
  const [redirectUri, setRedirectUri] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    if (state.data.configured && state.data.scopes) {
      // An option is checked when the stored ceiling covers its whole bundle.
      // A ceiling saved before the granular migration matches nothing —
      // leave the defaults checked so re-saving lands on sane granular scopes.
      const stored = new Set(state.data.scopes.split(/\s+/));
      const matching = options.filter((option) => optionWithin(option, stored));
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
    const scopes = [...scopesOfOptions(options, checkedIds), alwaysScope].join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      enabled,
      scopes,
      ...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
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
      <Card title={title} status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title={title} status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title={title}
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {intro ?? (
          <>
            The OAuth 2.0 (3LO) app from{' '}
            <a
              href="https://developer.atlassian.com/console/myapps/"
              className="text-blue-600 hover:underline dark:text-blue-400"
              target="_blank"
              rel="noreferrer"
            >
              developer.atlassian.com
            </a>
            . Its callback URL must be <CallbackUrl origin={origin} />.
          </>
        )}
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor={`${connector}-client-id`} className={labelClass}>
            Client ID
          </label>
          <input
            id={`${connector}-client-id`}
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor={`${connector}-client-secret`} className={labelClass}>
            Client secret
          </label>
          <input
            id={`${connector}-client-secret`}
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
          <fieldset>
            <legend className={labelClass}>What users may grant</legend>
            <ScopePicker
              groups={groups}
              options={options}
              checked={checkedIds}
              onToggle={toggleOption}
            />
            <p className={hintClass}>
              {scopeHint ?? (
                <>
                  This is the ceiling: users can narrow it when they connect, never widen it. Every
                  checked scope must also be granted to the app on developer.atlassian.com —
                  Atlassian refuses the authorize step otherwise.{' '}
                  <code className="font-mono text-xs">{ATLASSIAN_OFFLINE_SCOPE}</code> is always
                  included (without it grants die within an hour). Users who already connected keep
                  their old scopes until they reconnect.
                </>
              )}
            </p>
          </fieldset>
        </div>
        <div>
          <label htmlFor={`${connector}-redirect`} className={labelClass}>
            Redirect URI override <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id={`${connector}-redirect`}
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
