'use client';

import { ReactNode, useEffect, useState } from 'react';

/**
 * What every connector form shares. The forms (one file each, beside this
 * one) are each a thin skin over their /api/admin/[slug]/connectors/* route.
 * GET reports presence only — a stored secret comes back as `hasX: true`,
 * never as its value. Once a secret is stored, its field may be left blank
 * on save: the blank field is omitted from the PUT and the server keeps the
 * stored value, so settings-only saves never demand re-entering secrets. A
 * secret is required only when none is stored yet.
 */

export interface FetchState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

export function useConnectorConfig<T>(url: string): [FetchState<T>, () => void] {
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

export async function putJson(url: string, body: unknown): Promise<string | null> {
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

export function Card({
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

export function StatusPill({ configured, enabled }: { configured: boolean; enabled: boolean }) {
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
export function CallbackUrl({ origin }: { origin: string | null }) {
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

export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
export const labelClass = 'block text-sm font-medium mb-1';
export const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

export function SaveRow({
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
