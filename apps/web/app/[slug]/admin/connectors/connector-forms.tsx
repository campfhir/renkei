'use client';

import { FormEvent, ReactNode, useEffect, useState } from 'react';
import {
  WEBEX_USER_SCOPE_OPTIONS,
  WEBEX_SCOPE_GROUPS,
  WEBEX_REQUIRED_SCOPES,
} from '@/lib/webex-scopes';
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
import {
  MICROSOFT_SCOPE_GROUPS,
  MICROSOFT_SCOPE_OPTIONS,
  MICROSOFT_REQUIRED_SCOPES,
} from '@/lib/microsoft-scopes';
import { ZOOM_SCOPE_GROUPS, ZOOM_SCOPE_OPTIONS, ZOOM_REQUIRED_SCOPES } from '@/lib/zoom-scopes';
import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import ScopePicker from '@/components/scope-picker';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';

/**
 * The connector forms, each a thin skin over its
 * /api/admin/[slug]/connectors/* route. GET reports presence only — a stored
 * secret comes back as `hasX: true`, never as its value. Once a secret is
 * stored, its field may be left blank on save: the blank field is omitted
 * from the PUT and the server keeps the stored value, so settings-only saves
 * never demand re-entering secrets. A secret is required only when none is
 * stored yet.
 */

interface FetchState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

function useConnectorConfig<T>(url: string): [FetchState<T>, () => void] {
  const [state, setState] = useState<FetchState<T>>({ loading: true, error: null, data: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok) {
          const message =
            typeof body === 'object' && body !== null && typeof body.error === 'string'
              ? body.error
              : `Request failed (${r.status})`;
          setState({ loading: false, error: message, data: null });
          return;
        }
        setState({ loading: false, error: null, data: body });
      })
      .catch(() => {
        if (!cancelled)
          setState({ loading: false, error: 'Could not reach the server', data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  return [state, () => setNonce((n) => n + 1)];
}

async function putJson(url: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const data: unknown = await response.json().catch(() => null);
    if (typeof data === 'object' && data !== null) {
      const record: Record<string, unknown> = { ...data };
      if (typeof record.error === 'string') return record.error;
    }
    return `Request failed (${response.status})`;
  } catch {
    return 'Could not reach the server';
  }
}

function Card({
  title,
  status,
  children,
}: {
  title: string;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-semibold">{title}</h2>
        {status}
      </div>
      {children}
    </div>
  );
}

function StatusPill({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  if (!configured) {
    return (
      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
        Not configured
      </span>
    );
  }
  return enabled ? (
    <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
      Enabled
    </span>
  ) : (
    <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
      Disabled
    </span>
  );
}

/**
 * The OAuth callback URL, concrete when the deployment's origin is known —
 * admins paste it into a provider console, so an exact address beats a
 * description of one. Abstract phrasing only when the public base URL is
 * not configured yet (and no proxy header revealed the origin).
 */
function CallbackUrl({ origin }: { origin: string | null }) {
  if (origin) {
    return <code className="font-mono text-xs">{origin}/api/oauth/callback</code>;
  }
  return (
    <>
      this deployment&apos;s origin + <code className="font-mono text-xs">/api/oauth/callback</code>{' '}
      (the public base URL is not configured yet, so the exact address cannot be shown)
    </>
  );
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

function SaveRow({
  busy,
  notice,
  error,
}: {
  busy: boolean;
  notice: string | null;
  error: string | null;
}) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      {notice && <span className="text-sm text-green-700 dark:text-green-300">{notice}</span>}
      {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

interface AtlassianConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  redirectUri: string | null;
  hasClientSecret: boolean;
}

function AtlassianForm({ slug, origin }: { slug: string; origin: string | null }) {
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

function AtlassianJsmForm({ slug, origin }: { slug: string; origin: string | null }) {
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

function AtlassianConfluenceForm({ slug, origin }: { slug: string; origin: string | null }) {
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

function AtlassianBitbucketForm({ slug, origin }: { slug: string; origin: string | null }) {
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

/* ----------------------------------------------------------------------- */

/* ----------------------------------------------------------------------- */

interface WebexUserConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

function WebexUserForm({ slug, origin }: { slug: string; origin: string | null }) {
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

/* ----------------------------------------------------------------------- */

interface MicrosoftConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  directoryTenantId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

function MicrosoftForm({ slug, origin }: { slug: string; origin: string | null }) {
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

/* ----------------------------------------------------------------------- */

interface ZoomConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
  hasSecretToken: boolean;
}

function ZoomForm({
  slug,
  tenantId,
  origin,
}: {
  slug: string;
  tenantId: string;
  origin: string | null;
}) {
  const url = `/api/admin/${slug}/connectors/zoom`;
  const [state, reload] = useConnectorConfig<ZoomConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [secretToken, setSecretToken] = useState('');
  // Checked scopes, user:read:user excluded — it is always sent, never a
  // choice.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(ZOOM_SCOPE_OPTIONS.map((option) => option.id))
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
      const matching = ZOOM_SCOPE_OPTIONS.filter((option) => optionWithin(option, stored));
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
      ...scopesOfOptions(ZOOM_SCOPE_OPTIONS, checkedIds),
      ...ZOOM_REQUIRED_SCOPES,
    ].join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      ...(secretToken.trim() ? { secretToken: secretToken.trim() } : {}),
      enabled,
      scopes,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setClientSecret('');
    setSecretToken('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Zoom" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Zoom" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Zoom"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        A user-managed General app from the{' '}
        <a
          href="https://marketplace.zoom.us/user/build"
          className="text-blue-600 hover:underline dark:text-blue-400"
          target="_blank"
          rel="noreferrer"
        >
          Zoom Marketplace
        </a>{' '}
        through which each person grants Renkei access to their own Zoom — meetings, recordings,
        transcripts, AI Companion summaries. Its redirect URL must be{' '}
        <CallbackUrl origin={origin} />.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="zm-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="zm-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="zm-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="zm-client-secret"
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
          <label htmlFor="zm-secret-token" className={labelClass}>
            Webhook Secret Token <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="zm-secret-token"
            type="password"
            value={secretToken}
            onChange={(e) => setSecretToken(e.target.value)}
            placeholder={config?.hasSecretToken ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          <div className={hintClass}>
            <p>Verifies webhook deliveries and answers Zoom&apos;s URL validation. To set up:</p>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              <li>
                In the Marketplace app, open Features → Access and copy the Secret Token into this
                field.
              </li>
              <li>
                Under Features → Access, add an Event Subscription with endpoint URL{' '}
                {origin ? (
                  <code className="font-mono text-xs">
                    {origin}/api/webhooks/zoom/{tenantId}
                  </code>
                ) : (
                  <>
                    this deployment&apos;s origin +{' '}
                    <code className="font-mono text-xs">/api/webhooks/zoom/{tenantId}</code> (the
                    public base URL is not configured yet, so the exact address cannot be shown)
                  </>
                )}
                .
              </li>
              <li>
                Subscribe to the events{' '}
                <code className="font-mono text-xs">recording.transcript_completed</code> and{' '}
                <code className="font-mono text-xs">meeting.summary_completed</code>.
              </li>
              <li>
                Save the endpoint only after saving this form — Zoom validates the URL immediately,
                and validation needs the Secret Token stored here first.
              </li>
            </ol>
            {config?.hasSecretToken && (
              <p className="mt-1">A token is stored but never shown; leave blank to keep it.</p>
            )}
          </div>
        </div>
        <fieldset>
          <legend className={labelClass}>What users may grant</legend>
          <ScopePicker
            groups={ZOOM_SCOPE_GROUPS}
            options={ZOOM_SCOPE_OPTIONS}
            checked={checkedIds}
            onToggle={toggleOption}
          />
          <p className={hintClass}>
            This catalog must mirror the scopes selected on the Marketplace app: Zoom&apos;s consent
            screen cannot narrow, so every grant carries the app&apos;s full scope set. A
            user&apos;s narrower selection is enforced by Renkei at tool registration — unchecked
            capabilities never register.{' '}
            <code className="font-mono text-xs">{ZOOM_REQUIRED_SCOPES.join(' ')}</code> is always
            included (identifying who granted). Users who already connected keep their old selection
            until they reconnect.
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

/* ----------------------------------------------------------------------- */

interface EmbeddingsConfig {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  queryPrefix?: string;
  passagePrefix?: string;
  maxDistance?: number | null;
}

function EmbeddingsForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/embeddings`;
  const [state, reload] = useConnectorConfig<EmbeddingsConfig>(url);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [queryPrefix, setQueryPrefix] = useState('');
  const [passagePrefix, setPassagePrefix] = useState('');
  const [maxDistance, setMaxDistance] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setBaseUrl(state.data.baseUrl ?? '');
    setModel(state.data.model ?? '');
    setQueryPrefix(state.data.queryPrefix ?? '');
    setPassagePrefix(state.data.passagePrefix ?? '');
    setMaxDistance(
      typeof state.data.maxDistance === 'number' ? String(state.data.maxDistance) : ''
    );
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      // Prefixes are NOT trimmed: for the models that want one, the
      // trailing space is part of it ("query: ").
      queryPrefix,
      passagePrefix,
      maxDistance: maxDistance.trim(),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setApiKey('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Embeddings" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Embeddings" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Embeddings"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        The provider the knowledge layer uses to embed content for retrieval.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="em-base" className={labelClass}>
            Base URL
          </label>
          <input
            id="em-base"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="em-model" className={labelClass}>
            Model
          </label>
          <input
            id="em-model"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="text-embedding-3-small"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="em-key" className={labelClass}>
            API key
          </label>
          <input
            id="em-key"
            type="password"
            required={!config?.hasApiKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasApiKey && (
            <p className={hintClass}>A key is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="em-qprefix" className={labelClass}>
              Query prefix
            </label>
            <input
              id="em-qprefix"
              value={queryPrefix}
              onChange={(e) => setQueryPrefix(e.target.value)}
              placeholder="query: "
              className={`${inputClass} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="em-pprefix" className={labelClass}>
              Passage prefix
            </label>
            <input
              id="em-pprefix"
              value={passagePrefix}
              onChange={(e) => setPassagePrefix(e.target.value)}
              placeholder="passage: "
              className={`${inputClass} font-mono`}
            />
          </div>
        </div>
        <p className={hintClass}>
          Only for models that embed queries and documents differently (e5, bge, nomic, mxbai —
          typically served through vLLM, TEI or Ollama). Prepended verbatim, trailing space
          included. Leave both blank for OpenAI, Cohere, Voyage and similar. Changing the passage
          prefix means re-indexing.
        </p>
        <div>
          <label htmlFor="em-cutoff" className={labelClass}>
            Relevance cutoff (cosine distance)
          </label>
          <input
            id="em-cutoff"
            inputMode="decimal"
            value={maxDistance}
            onChange={(e) => setMaxDistance(e.target.value)}
            placeholder="blank = no cutoff"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Matches farther than this are dropped and reported as a count, and result grades (strong
            / good / possible) are scaled to it. Model-specific: around 0.55 suits bge or e5, around
            0.75 suits text-embedding-3. Keyword matches are always kept.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
      {config?.configured && <ReindexPanel slug={slug} />}
    </Card>
  );
}

/* ----------------------------------------------------------------------- */

type ReindexKind = 'lexical' | 'embed' | 'keywords';

interface ReindexRun {
  id: string;
  kind: ReindexKind;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const REINDEX_ACTIONS: { kind: ReindexKind; label: string; hint: string; unit: string }[] = [
  {
    kind: 'lexical',
    label: 'Rebuild keyword index',
    hint: 'Fills the exact-word index for items indexed before it existed. No provider calls; safe to run any time.',
    unit: 'chunks',
  },
  {
    kind: 'embed',
    label: 'Re-embed with context headers',
    hint: 'Recomputes the vectors of multi-part items so every part knows its document. One embeddings call per 64 chunks; run after changing the model or the passage prefix.',
    unit: 'chunks',
  },
  {
    kind: 'keywords',
    label: 'Extract keywords for existing items',
    hint: 'One call to the default LLM model per item that has none yet. Only when keyword enrichment is on under Settings.',
    unit: 'items',
  },
];

/** The route's `runs` list, field-checked rather than trusted. */
function readRuns(body: unknown): ReindexRun[] {
  if (typeof body !== 'object' || body === null) return [];
  const runs = Reflect.get(body, 'runs');
  if (!Array.isArray(runs)) return [];
  const out: ReindexRun[] = [];
  for (const entry of runs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record: Record<string, unknown> = { ...entry };
    const kind = record.kind;
    if (kind !== 'lexical' && kind !== 'embed' && kind !== 'keywords') continue;
    if (typeof record.id !== 'string' || typeof record.status !== 'string') continue;
    out.push({
      id: record.id,
      kind,
      status: record.status,
      processed: typeof record.processed === 'number' ? record.processed : 0,
      skipped: typeof record.skipped === 'number' ? record.skipped : 0,
      failed: typeof record.failed === 'number' ? record.failed : 0,
      lastError: typeof record.lastError === 'string' ? record.lastError : null,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
      finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    });
  }
  return out;
}

function isActive(run: ReindexRun | undefined): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}

/** Paused or failed: stopped, but its cursor makes it resumable rather than a do-over. */
function isResumable(run: ReindexRun | undefined): boolean {
  return run?.status === 'paused' || run?.status === 'failed';
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function runSummary(run: ReindexRun | undefined, unit: string): string {
  if (!run) return 'Never run';
  const count = `${run.processed.toLocaleString()} ${unit}`;
  switch (run.status) {
    case 'queued':
      return 'Queued…';
    case 'running':
      return `Running — ${count} so far`;
    case 'done':
      return (
        `Done ${relativeTime(run.finishedAt)} — ${count}` +
        (run.skipped > 0 ? `, ${run.skipped} unreadable skipped` : '') +
        (run.failed > 0 ? `, ${run.failed} failed` : '')
      );
    case 'failed':
      return `Failed ${relativeTime(run.finishedAt ?? run.createdAt)} after ${count}: ${run.lastError ?? 'unknown error'}`;
    case 'paused':
      return `Paused — ${count} so far`;
    default:
      return run.status;
  }
}

type ReindexAction = 'start' | 'pause' | 'resume';

const primaryButtonClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800';
const secondaryButtonClass =
  'rounded-md px-3 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800';

/**
 * The reindex buttons. Each starts a queue-driven run the worker chains
 * through in short batches; this panel only asks and watches. Polls while
 * anything is running, and stops when nothing is — a page left open does
 * not keep hitting the server for a run that ended an hour ago.
 *
 * A run's own stored cursor is what lets Resume pick up a paused or failed
 * run instead of redoing it: Pause (shown next to an active run) stops the
 * chain after its current in-flight link; Resume (shown for a paused or
 * failed run) re-arms it from where it stopped; Start fresh discards that
 * history and begins a brand new run at the top.
 */

function ReindexPanel({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/embeddings/reindex`;
  const [runs, setRuns] = useState<ReindexRun[] | null>(null);
  const [busy, setBusy] = useState<{ kind: ReindexKind; action: ReindexAction } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = new Map<ReindexKind, ReindexRun>();
  for (const run of runs ?? []) if (!latest.has(run.kind)) latest.set(run.kind, run);
  const anyActive = [...latest.values()].some(isActive);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(url).catch(() => null);
      const body: unknown = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      setRuns(readRuns(body));
    }
    void load();
    if (!anyActive)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, anyActive]);

  async function act(kind: ReindexKind, action: ReindexAction, runId?: string) {
    setBusy({ kind, action });
    setError(null);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, action, ...(runId ? { runId } : {}) }),
      });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (!response.ok) {
        setError(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
        return;
      }
      if (Array.isArray(record.runs)) setRuns(readRuns(body));
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-800">
      <p className="text-sm font-semibold">Reindex</p>
      <p className={hintClass}>
        Bring already-indexed content up to date with the current search pipeline. Runs in the
        background in batches; search keeps working meanwhile. Re-syncing a source from its
        connector does the same for that source.
      </p>
      <div className="mt-3 space-y-3">
        {REINDEX_ACTIONS.map((action) => {
          const run = latest.get(action.kind);
          const active = isActive(run);
          const resumable = isResumable(run);
          const disabled = busy !== null || runs === null;
          const busyWith = (a: ReindexAction) =>
            busy?.kind === action.kind && busy.action === a;
          return (
            <div
              key={action.kind}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1"
            >
              <div className="min-w-0 max-w-md">
                <p className="text-sm font-medium">{action.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{action.hint}</p>
                <p
                  className={`mt-0.5 text-xs ${
                    run?.status === 'failed'
                      ? 'text-red-700 dark:text-red-300'
                      : active || run?.status === 'paused'
                        ? 'text-blue-700 dark:text-blue-400'
                        : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {runs === null ? 'Loading…' : runSummary(run, action.unit)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {active && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void act(action.kind, 'pause', run?.id)}
                    className={secondaryButtonClass}
                  >
                    {busyWith('pause') ? 'Pausing…' : 'Pause'}
                  </button>
                )}
                {resumable && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void act(action.kind, 'start')}
                    className={secondaryButtonClass}
                  >
                    {busyWith('start') ? 'Starting…' : 'Start fresh'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={active || disabled}
                  onClick={() =>
                    void act(action.kind, resumable ? 'resume' : 'start', run?.id)
                  }
                  className={primaryButtonClass}
                >
                  {active
                    ? 'Running…'
                    : resumable
                      ? busyWith('resume')
                        ? 'Resuming…'
                        : 'Resume'
                      : busyWith('start')
                        ? 'Starting…'
                        : 'Run'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

interface MistralOcrConfig {
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  hasApiKey: boolean;
}

function MistralOcrForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/mistral-ocr`;
  const [state, reload] = useConnectorConfig<MistralOcrConfig>(url);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setEndpoint(state.data.endpoint ?? '');
    setModel(state.data.model ?? '');
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      endpoint: endpoint.trim(),
      model: model.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setApiKey('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Mistral OCR" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Mistral OCR" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Mistral OCR"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Mistral Document AI (OCR 4) as deployed on your org&apos;s Microsoft Foundry — used by batch
        document pipelines and the ad-hoc OCR tool. One org-wide key, no per-user sign-in.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="mo-endpoint" className={labelClass}>
            Foundry endpoint URL
          </label>
          <input
            id="mo-endpoint"
            required
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://your-resource.services.ai.azure.com/models"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="mo-model" className={labelClass}>
            Model / deployment name
          </label>
          <input
            id="mo-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="mistral-ocr-4-0 (default if left blank)"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="mo-key" className={labelClass}>
            API key
          </label>
          <input
            id="mo-key"
            type="password"
            required={!config?.hasApiKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasApiKey && (
            <p className={hintClass}>A key is stored but never shown; leave blank to keep it.</p>
          )}
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

/* ----------------------------------------------------------------------- */

interface WebSearchConfig {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  apiVersion: string | null;
  reasoningEffort: string | null;
  userLocation: { country?: string; city?: string; region?: string; timezone?: string } | null;
  allowedDomains: string[];
  blockedDomains: string[];
  hasApiKey: boolean;
}

/**
 * The web-search connector: the Azure OpenAI (or OpenAI) Responses API
 * deployment whose built-in `web_search` tool answers the `web_search`
 * MCP tool. Org-wide like Embeddings and Mistral OCR — one endpoint, one
 * deployment, one key — plus the org policy that shapes every search: an
 * approximate location and domain allow/block lists.
 */
function WebSearchForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/web-search`;
  const [state, reload] = useConnectorConfig<WebSearchConfig>(url);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [timezone, setTimezone] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [blockedDomains, setBlockedDomains] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setBaseUrl(state.data.baseUrl ?? '');
    setModel(state.data.model ?? '');
    setApiVersion(state.data.apiVersion ?? '');
    setReasoningEffort(state.data.reasoningEffort ?? '');
    setCountry(state.data.userLocation?.country ?? '');
    setCity(state.data.userLocation?.city ?? '');
    setRegion(state.data.userLocation?.region ?? '');
    setTimezone(state.data.userLocation?.timezone ?? '');
    setAllowedDomains((state.data.allowedDomains ?? []).join('\n'));
    setBlockedDomains((state.data.blockedDomains ?? []).join('\n'));
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      apiVersion: apiVersion.trim(),
      reasoningEffort,
      userLocation: {
        country: country.trim(),
        city: city.trim(),
        region: region.trim(),
        timezone: timezone.trim(),
      },
      allowedDomains: allowedDomains.split(/[\s,]+/).filter(Boolean),
      blockedDomains: blockedDomains.split(/[\s,]+/).filter(Boolean),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setApiKey('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Web search" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Web search" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Web search"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Public-web search for models and agents, through an Azure OpenAI deployment&apos;s built-in{' '}
        <code className="font-mono text-xs">web_search</code> tool (Grounding with Bing) on the
        Responses API. One org-wide key; every <code className="font-mono text-xs">web_search</code>{' '}
        call is billed as a Bing search, and the query text leaves the Azure compliance boundary.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="ws-base" className={labelClass}>
            Base URL
          </label>
          <input
            id="ws-base"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://{resource}.openai.azure.com/openai/v1"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            The resource&apos;s OpenAI-compatible v1 surface; Renkei appends{' '}
            <code className="font-mono text-xs">/responses</code>. OpenAI itself is{' '}
            <code className="font-mono text-xs">https://api.openai.com/v1</code>.
          </p>
        </div>
        <div>
          <label htmlFor="ws-model" className={labelClass}>
            Deployment (model)
          </label>
          <input
            id="ws-model"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5.5"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Your deployment name on Azure AI Foundry — a GPT-4-or-later model that supports web
            search; a reasoning model (GPT-5 family) gives agentic multi-step search.
          </p>
        </div>
        <div>
          <label htmlFor="ws-key" className={labelClass}>
            API key
          </label>
          <input
            id="ws-key"
            type="password"
            required={!config?.hasApiKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasApiKey && (
            <p className={hintClass}>A key is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ws-effort" className={labelClass}>
              Reasoning effort <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <select
              id="ws-effort"
              className={inputClass}
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
            >
              <option value="">Model default</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </select>
            <p className={hintClass}>
              Reasoning models only. Higher means deeper, slower searches; low keeps a lookup quick.
            </p>
          </div>
          <div>
            <label htmlFor="ws-api-version" className={labelClass}>
              API version <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="ws-api-version"
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
              placeholder="blank for the /openai/v1 surface"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              Appended as <code className="font-mono text-xs">?api-version=…</code> only when the
              surface demands it.
            </p>
          </div>
        </div>
        <fieldset>
          <legend className={labelClass}>
            Default location <span className="font-normal text-gray-500">(optional)</span>
          </legend>
          <div className="grid gap-3 sm:grid-cols-4">
            <input
              aria-label="Country code"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="US"
              maxLength={2}
              className={`${inputClass} font-mono`}
            />
            <input
              aria-label="City"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Chicago"
              className={inputClass}
            />
            <input
              aria-label="Region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="Illinois"
              className={inputClass}
            />
            <input
              aria-label="Time zone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/Chicago"
              className={`${inputClass} font-mono`}
            />
          </div>
          <p className={hintClass}>
            Results are tuned to this approximate location (two-letter country code, city, region,
            IANA time zone) unless a call passes its own. Leave blank for no preference.
          </p>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ws-allowed" className={labelClass}>
              Allowed domains <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <textarea
              id="ws-allowed"
              rows={4}
              value={allowedDomains}
              onChange={(e) => setAllowedDomains(e.target.value)}
              placeholder={'learn.microsoft.com\nwww.who.int'}
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              One per line, up to 100. When set, results come only from these sites (subdomains
              included) and callers can narrow further but never beyond them.
            </p>
          </div>
          <div>
            <label htmlFor="ws-blocked" className={labelClass}>
              Blocked domains <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <textarea
              id="ws-blocked"
              rows={4}
              value={blockedDomains}
              onChange={(e) => setBlockedDomains(e.target.value)}
              placeholder={'en.wikipedia.org\nwww.reddit.com'}
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>One per line. Never surfaced as a source.</p>
          </div>
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

/* ----------------------------------------------------------------------- */

interface OnBaseConfig {
  configured: boolean;
  enabled: boolean;
  apiBaseUrl: string | null;
  idpIssuer: string | null;
  clientId: string | null;
  idpScopeName: string | null;
  allowInsecureHttp: boolean;
  hasClientSecret: boolean;
}

interface OnBaseTestResult {
  idp: { ok: boolean; tokenEndpoint?: string; error?: string };
  api: { ok: boolean; status?: number; error?: string };
}

function OnBaseForm({ slug, origin }: { slug: string; origin: string | null }) {
  const url = `/api/admin/${slug}/connectors/onbase`;
  const [state, reload] = useConnectorConfig<OnBaseConfig>(url);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [idpIssuer, setIdpIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [idpScopeName, setIdpScopeName] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OnBaseTestResult | string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setApiBaseUrl(state.data.apiBaseUrl ?? '');
    setIdpIssuer(state.data.idpIssuer ?? '');
    setClientId(state.data.clientId ?? '');
    setIdpScopeName(state.data.idpScopeName ?? '');
    setAllowInsecureHttp(state.data.allowInsecureHttp);
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      apiBaseUrl: apiBaseUrl.trim(),
      idpIssuer: idpIssuer.trim(),
      clientId: clientId.trim(),
      idpScopeName: idpScopeName.trim(),
      allowInsecureHttp,
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      enabled,
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

  // Tests the form's CURRENT values (saved or not), through the OnBase
  // worker — the web app itself never dials the customer's servers.
  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`${url}/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiBaseUrl: apiBaseUrl.trim(),
          idpIssuer: idpIssuer.trim(),
          allowInsecureHttp,
        }),
      });
      const data: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof data === 'object' && data !== null ? { ...data } : {};
      if (!response.ok) {
        setTestResult(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
        return;
      }
      const side = (
        value: unknown
      ): { ok: boolean; error?: string; status?: number; tokenEndpoint?: string } => {
        const raw: Record<string, unknown> =
          typeof value === 'object' && value !== null ? { ...value } : {};
        return {
          ok: raw.ok === true,
          ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
          ...(typeof raw.status === 'number' ? { status: raw.status } : {}),
          ...(typeof raw.tokenEndpoint === 'string' ? { tokenEndpoint: raw.tokenEndpoint } : {}),
        };
      };
      setTestResult({ idp: side(record.idp), api: side(record.api) });
    } catch {
      setTestResult('Could not reach the server');
    } finally {
      setTesting(false);
    }
  }

  if (state.loading)
    return (
      <Card title="OnBase" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="OnBase" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="OnBase"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Your organization&apos;s own OnBase API Server and Hyland Identity Provider — there is no
        vendor console. Register a client for Renkei on the Hyland IdP with redirect URI{' '}
        <CallbackUrl origin={origin} />, then enter the details below. Each person connects their
        own OnBase account from the Connectors page.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="ob-api" className={labelClass}>
            API server base URL
          </label>
          <input
            id="ob-api"
            required
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://onbase.example.com/apiserver/onbase/core"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            The Document Management API base — the paths under it are e.g. /documents,
            /document-types.
          </p>
        </div>
        <div>
          <label htmlFor="ob-idp" className={labelClass}>
            Hyland IdP issuer URL
          </label>
          <input
            id="ob-idp"
            required
            value={idpIssuer}
            onChange={(e) => setIdpIssuer(e.target.value)}
            placeholder="https://onbase.example.com/identityprovider"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            OIDC discovery is read from &lt;issuer&gt;/.well-known/openid-configuration by the
            OnBase worker.
          </p>
        </div>
        <div>
          <label htmlFor="ob-client" className={labelClass}>
            Client ID
          </label>
          <input
            id="ob-client"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="ob-scope" className={labelClass}>
            IdP scope name
          </label>
          <input
            id="ob-scope"
            required
            value={idpScopeName}
            onChange={(e) => setIdpScopeName(e.target.value)}
            placeholder="documentManagementApi"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Must match the API Server&apos;s configured scope (5_document_management.json → IdP
            Scope Name).
          </p>
        </div>
        <div>
          <label htmlFor="ob-secret" className={labelClass}>
            Client secret (optional)
          </label>
          <input
            id="ob-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={
              config?.hasClientSecret
                ? 'Stored — leave blank to keep'
                : 'Public PKCE client: leave blank'
            }
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowInsecureHttp}
            onChange={(e) => setAllowInsecureHttp(e.target.checked)}
          />
          Allow insecure HTTP (bearer tokens travel unencrypted — lab servers only)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing || !apiBaseUrl.trim() || !idpIssuer.trim()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {notice && <span className="text-sm text-green-700 dark:text-green-300">{notice}</span>}
          {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
        </div>
        {typeof testResult === 'string' && (
          <p className="text-sm text-red-700 dark:text-red-300">{testResult}</p>
        )}
        {testResult !== null && typeof testResult === 'object' && (
          <ul className="space-y-1 text-sm">
            <li
              className={
                testResult.idp.ok
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }
            >
              {testResult.idp.ok
                ? 'IdP reachable — discovery answered.'
                : `IdP: ${testResult.idp.error ?? 'unreachable'}`}
            </li>
            <li
              className={
                testResult.api.ok
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }
            >
              {testResult.api.ok
                ? `API server reachable${testResult.api.status === 401 ? ' — it demands authentication, as expected' : ''}.`
                : `API server: ${testResult.api.error ?? 'unreachable'}`}
            </li>
          </ul>
        )}
      </form>
    </Card>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * OnBase Administration — a SEPARATE connector from OnBase above: a
 * different Hyland OAuth client (the Administration API, not the Document
 * Management API), its own `connector_configs` row, its own grants. A
 * near-duplicate of OnBaseForm rather than a shared component, mirroring
 * how AtlassianConfluenceForm/AtlassianBitbucketForm are their own
 * components alongside AtlassianForm/AtlassianJsmForm.
 */
function OnBaseAdminForm({ slug, origin }: { slug: string; origin: string | null }) {
  const url = `/api/admin/${slug}/connectors/onbase-admin`;
  const [state, reload] = useConnectorConfig<OnBaseConfig>(url);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [idpIssuer, setIdpIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [idpScopeName, setIdpScopeName] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OnBaseTestResult | string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setApiBaseUrl(state.data.apiBaseUrl ?? '');
    setIdpIssuer(state.data.idpIssuer ?? '');
    setClientId(state.data.clientId ?? '');
    setIdpScopeName(state.data.idpScopeName ?? '');
    setAllowInsecureHttp(state.data.allowInsecureHttp);
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      apiBaseUrl: apiBaseUrl.trim(),
      idpIssuer: idpIssuer.trim(),
      clientId: clientId.trim(),
      idpScopeName: idpScopeName.trim(),
      allowInsecureHttp,
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      enabled,
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

  // Tests the form's CURRENT values (saved or not), through the OnBase
  // worker — the web app itself never dials the customer's servers.
  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`${url}/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiBaseUrl: apiBaseUrl.trim(),
          idpIssuer: idpIssuer.trim(),
          allowInsecureHttp,
        }),
      });
      const data: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof data === 'object' && data !== null ? { ...data } : {};
      if (!response.ok) {
        setTestResult(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
        return;
      }
      const side = (
        value: unknown
      ): { ok: boolean; error?: string; status?: number; tokenEndpoint?: string } => {
        const raw: Record<string, unknown> =
          typeof value === 'object' && value !== null ? { ...value } : {};
        return {
          ok: raw.ok === true,
          ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
          ...(typeof raw.status === 'number' ? { status: raw.status } : {}),
          ...(typeof raw.tokenEndpoint === 'string' ? { tokenEndpoint: raw.tokenEndpoint } : {}),
        };
      };
      setTestResult({ idp: side(record.idp), api: side(record.api) });
    } catch {
      setTestResult('Could not reach the server');
    } finally {
      setTesting(false);
    }
  }

  if (state.loading)
    return (
      <Card title="OnBase Administration" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="OnBase Administration" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="OnBase Administration"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        A SEPARATE Hyland client from OnBase above — the Administration API, which creates and
        configures document types and keyword types rather than filing documents. Register a second
        client for Renkei on the Hyland IdP with redirect URI <CallbackUrl origin={origin} />, then
        enter its details below. Optional: leave this card unconfigured to keep configuration access
        out of Renkei entirely while still using OnBase for documents.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="ob-admin-api" className={labelClass}>
            Administration API base URL
          </label>
          <input
            id="ob-admin-api"
            required
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://onbase.example.com/apiserver/onbase/administration"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            The Administration API base — the paths under it are e.g. /api/document-types,
            /api/keyword-types.
          </p>
        </div>
        <div>
          <label htmlFor="ob-admin-idp" className={labelClass}>
            Hyland IdP issuer URL
          </label>
          <input
            id="ob-admin-idp"
            required
            value={idpIssuer}
            onChange={(e) => setIdpIssuer(e.target.value)}
            placeholder="https://onbase.example.com/identityprovider"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            OIDC discovery is read from &lt;issuer&gt;/.well-known/openid-configuration by the
            OnBase worker.
          </p>
        </div>
        <div>
          <label htmlFor="ob-admin-client" className={labelClass}>
            Client ID
          </label>
          <input
            id="ob-admin-client"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="ob-admin-scope" className={labelClass}>
            IdP scope name
          </label>
          <input
            id="ob-admin-scope"
            required
            value={idpScopeName}
            onChange={(e) => setIdpScopeName(e.target.value)}
            placeholder="administrationApi"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Must match the API Server&apos;s configured scope for the Administration API client.
          </p>
        </div>
        <div>
          <label htmlFor="ob-admin-secret" className={labelClass}>
            Client secret (optional)
          </label>
          <input
            id="ob-admin-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={
              config?.hasClientSecret
                ? 'Stored — leave blank to keep'
                : 'Public PKCE client: leave blank'
            }
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowInsecureHttp}
            onChange={(e) => setAllowInsecureHttp(e.target.checked)}
          />
          Allow insecure HTTP (bearer tokens travel unencrypted — lab servers only)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing || !apiBaseUrl.trim() || !idpIssuer.trim()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {notice && <span className="text-sm text-green-700 dark:text-green-300">{notice}</span>}
          {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
        </div>
        {typeof testResult === 'string' && (
          <p className="text-sm text-red-700 dark:text-red-300">{testResult}</p>
        )}
        {testResult !== null && typeof testResult === 'object' && (
          <ul className="space-y-1 text-sm">
            <li
              className={
                testResult.idp.ok
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }
            >
              {testResult.idp.ok
                ? 'IdP reachable — discovery answered.'
                : `IdP: ${testResult.idp.error ?? 'unreachable'}`}
            </li>
            <li
              className={
                testResult.api.ok
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }
            >
              {testResult.api.ok
                ? `API server reachable${testResult.api.status === 401 ? ' — it demands authentication, as expected' : ''}.`
                : `API server: ${testResult.api.error ?? 'unreachable'}`}
            </li>
          </ul>
        )}
      </form>
    </Card>
  );
}

export default function ConnectorForms({
  slug,
  tenantId,
  origin,
}: {
  slug: string;
  tenantId: string;
  origin: string | null;
}) {
  return (
    <div className="space-y-6">
      <AtlassianForm slug={slug} origin={origin} />
      <AtlassianJsmForm slug={slug} origin={origin} />
      <AtlassianConfluenceForm slug={slug} origin={origin} />
      <AtlassianBitbucketForm slug={slug} origin={origin} />
      <WebexUserForm slug={slug} origin={origin} />
      <MicrosoftForm slug={slug} origin={origin} />
      <ZoomForm slug={slug} tenantId={tenantId} origin={origin} />
      <OnBaseForm slug={slug} origin={origin} />
      <OnBaseAdminForm slug={slug} origin={origin} />
      <MistralOcrForm slug={slug} />
      <EmbeddingsForm slug={slug} />
      <WebSearchForm slug={slug} />
    </div>
  );
}
