'use client';

import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { WEBEX_USER_SCOPE_OPTIONS, WEBEX_KMS_SCOPE } from '@/lib/webex-scopes';

/**
 * The three connector forms, each a thin skin over its
 * /api/admin/[slug]/connectors/* route. GET reports presence only — a stored
 * secret comes back as `hasX: true`, never as its value — and every PUT
 * requires the secret again, so the forms say that instead of faking a
 * filled-in field.
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

function AtlassianForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/atlassian`;
  const [state, reload] = useConnectorConfig<AtlassianConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    setScopes(state.data.scopes ?? '');
    setRedirectUri(state.data.redirectUri ?? '');
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      enabled,
      ...(scopes.trim() ? { scopes: scopes.trim() } : {}),
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
      <Card title="Atlassian (Jira)" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Atlassian (Jira)" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Atlassian (Jira)"
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
        . Its callback URL must be this deployment&apos;s origin +{' '}
        <code className="font-mono text-xs">/api/oauth/callback</code>.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="at-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="at-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="at-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="at-client-secret"
            type="password"
            required
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={config?.hasClientSecret ? 'Stored — re-enter to save changes' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>
              A secret is stored but never shown. Saving any change requires entering it again.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="at-scopes" className={labelClass}>
            Scopes <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="at-scopes"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            placeholder="read:jira-work write:jira-work read:jira-user offline_access"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="at-redirect" className={labelClass}>
            Redirect URI override <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id="at-redirect"
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

interface WebexConfig {
  configured: boolean;
  enabled: boolean;
  hasBotToken: boolean;
  hasWebhookSecret: boolean;
}

function WebexForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/webex`;
  const [state, reload] = useConnectorConfig<WebexConfig>(url);
  const [botToken, setBotToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  // Generating reveals the field: the operator needs to see what was minted
  // to store it in their own vault — the server will never show it again.
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function generateSecret() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setWebhookSecret(
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
    setSecretRevealed(true);
  }

  useEffect(() => {
    if (!state.data) return;
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      botToken: botToken.trim(),
      webhookSecret: webhookSecret.trim(),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setBotToken('');
    setWebhookSecret('');
    setSecretRevealed(false);
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="WebEx" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="WebEx" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="WebEx"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        The org bot that watches spaces for actionable messages.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="wx-token" className={labelClass}>
            Bot token
          </label>
          <input
            id="wx-token"
            type="password"
            required
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={config?.hasBotToken ? 'Stored — re-enter to save changes' : ''}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="wx-secret" className={labelClass}>
            Webhook secret
          </label>
          <div className="flex gap-2">
            <input
              id="wx-secret"
              type={secretRevealed ? 'text' : 'password'}
              required
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={config?.hasWebhookSecret ? 'Stored — re-enter to save changes' : ''}
              className={`${inputClass} font-mono`}
            />
            <button
              type="button"
              onClick={generateSecret}
              className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Generate
            </button>
          </div>
          <p className={hintClass}>
            A value you choose, not one WebEx issues — Renkei registers webhooks with it and WebEx
            signs every delivery using it. Generate fills in 32 random bytes.
            {config?.hasWebhookSecret || config?.hasBotToken
              ? ' Secrets are stored but never shown; saving any change requires entering both again.'
              : ''}
          </p>
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

interface WebexUserConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

function WebexUserForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/webex-user`;
  const [state, reload] = useConnectorConfig<WebexUserConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // Checked scopes, spark:kms excluded — it is always sent, never a choice.
  const [checkedScopes, setCheckedScopes] = useState<Set<string>>(
    () => new Set(WEBEX_USER_SCOPE_OPTIONS.map((option) => option.scope))
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
      setCheckedScopes(
        new Set(
          WEBEX_USER_SCOPE_OPTIONS.map((option) => option.scope).filter((scope) =>
            stored.has(scope)
          )
        )
      );
    }
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  function toggleScope(scope: string, on: boolean) {
    setCheckedScopes((current) => {
      const next = new Set(current);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const scopes = [
      ...WEBEX_USER_SCOPE_OPTIONS.map((option) => option.scope).filter((scope) =>
        checkedScopes.has(scope)
      ),
      WEBEX_KMS_SCOPE,
    ].join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
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
        they are in, messages they can see. Its redirect URI must be this deployment&apos;s origin +{' '}
        <code className="font-mono text-xs">/api/oauth/callback</code>.
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
            required
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={config?.hasClientSecret ? 'Stored — re-enter to save changes' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>
              A secret is stored but never shown. Saving any change requires entering it again.
            </p>
          )}
        </div>
        <fieldset>
          <legend className={labelClass}>What users may grant</legend>
          <div className="space-y-2">
            {WEBEX_USER_SCOPE_OPTIONS.map((option) => (
              <label key={option.scope} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checkedScopes.has(option.scope)}
                  onChange={(e) => toggleScope(option.scope, e.target.checked)}
                />
                <span>
                  {option.label}{' '}
                  <code className="font-mono text-xs text-gray-500">{option.scope}</code>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className={hintClass}>
            Unchecked scopes are never requested and their tools tell the caller why. Every checked
            scope must also be selected on the Integration at developer.webex.com — WebEx refuses
            the authorize step otherwise.{' '}
            <code className="font-mono text-xs">{WEBEX_KMS_SCOPE}</code> is always included
            (required to decrypt message content). Users who already connected keep their old scopes
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
      apiKey: apiKey.trim(),
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
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? 'Stored — re-enter to save changes' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasApiKey && (
            <p className={hintClass}>
              A key is stored but never shown. Saving any change requires entering it again.
            </p>
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

export default function ConnectorForms({ slug }: { slug: string }) {
  return (
    <div className="space-y-6">
      <AtlassianForm slug={slug} />
      <WebexForm slug={slug} />
      <WebexUserForm slug={slug} />
      <EmbeddingsForm slug={slug} />
    </div>
  );
}
