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
  ATLASSIAN_OFFLINE_SCOPE,
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
}: {
  slug: string;
  origin: string | null;
  connector: string;
  title: string;
  groups: ScopeGroup[];
  options: ScopeOption[];
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
    const scopes = [...scopesOfOptions(options, checkedIds), ATLASSIAN_OFFLINE_SCOPE].join(' ');
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
              This is the ceiling: users can narrow it when they connect, never widen it. Every
              checked scope must also be granted to the app on developer.atlassian.com — Atlassian
              refuses the authorize step otherwise.{' '}
              <code className="font-mono text-xs">{ATLASSIAN_OFFLINE_SCOPE}</code> is always
              included (without it grants die within an hour). Users who already connected keep
              their old scopes until they reconnect.
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
}

function EmbeddingsForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/embeddings`;
  const [state, reload] = useConnectorConfig<EmbeddingsConfig>(url);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setBaseUrl(state.data.baseUrl ?? '');
    setModel(state.data.model ?? '');
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
      const side = (value: unknown): { ok: boolean; error?: string; status?: number; tokenEndpoint?: string } => {
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
            OIDC discovery is read from
            &lt;issuer&gt;/.well-known/openid-configuration by the OnBase worker.
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
            placeholder={config?.hasClientSecret ? 'Stored — leave blank to keep' : 'Public PKCE client: leave blank'}
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
            <li className={testResult.idp.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}>
              {testResult.idp.ok
                ? 'IdP reachable — discovery answered.'
                : `IdP: ${testResult.idp.error ?? 'unreachable'}`}
            </li>
            <li className={testResult.api.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}>
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
      <WebexUserForm slug={slug} origin={origin} />
      <MicrosoftForm slug={slug} origin={origin} />
      <ZoomForm slug={slug} tenantId={tenantId} origin={origin} />
      <OnBaseForm slug={slug} origin={origin} />
      <EmbeddingsForm slug={slug} />
    </div>
  );
}
