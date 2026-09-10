'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  CallbackUrl,
  inputClass,
  labelClass,
  hintClass,
} from './shared';

/* ----------------------------------------------------------------------- */

export interface OnBaseConfig {
  configured: boolean;
  enabled: boolean;
  apiBaseUrl: string | null;
  idpIssuer: string | null;
  clientId: string | null;
  idpScopeName: string | null;
  allowInsecureHttp: boolean;
  hasClientSecret: boolean;
}

export interface OnBaseTestResult {
  idp: { ok: boolean; tokenEndpoint?: string; error?: string };
  api: { ok: boolean; status?: number; error?: string };
}

export function OnBaseForm({ slug, origin }: { slug: string; origin: string | null }) {
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
