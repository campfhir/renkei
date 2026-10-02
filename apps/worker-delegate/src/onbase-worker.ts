/**
 * OnBase tokens come from a customer-hosted Hyland IdP that only the
 * OnBase egress worker dials (apps/worker-onbase). The delegate therefore
 * asks that worker to refresh, exchange and revoke OnBase tokens, the way
 * the web app used to — the token itself still lands only here.
 *
 * Configuration: ONBASE_WORKER_URL + ONBASE_WORKER_API_KEY; absent means
 * OnBase refreshes fail closed as REFRESH_FAILED.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { OnBaseRefresh, RefreshedTokens, RefreshError } from '@renkei/provider-grants';

const TIMEOUT_MS = 30_000;

function config(): { url: string; apiKey: string } | null {
  const url = process.env.ONBASE_WORKER_URL?.trim().replace(/\/+$/, '');
  const apiKey = process.env.ONBASE_WORKER_API_KEY?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function onbaseWorkerCall(
  op: string,
  body: Record<string, unknown>
): Promise<Result<Record<string, unknown>, 'UNCONFIGURED' | 'UNREACHABLE' | 'REFUSED'>> {
  const cfg = config();
  if (!cfg) return err('UNCONFIGURED');
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return err('UNREACHABLE');
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(json)) {
    const error = isRecord(json) && isRecord(json.error) ? json.error : {};
    return err('REFUSED', {
      message: typeof error.type === 'string' ? error.type : String(response.status),
    });
  }
  return ok(json);
}

/** A token-endpoint answer from the worker, as the generic lifecycle wants it. */
export function refreshedOf(
  json: Record<string, unknown>,
  previousRefreshToken: string
): RefreshedTokens | null {
  if (typeof json.access_token !== 'string') return null;
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    refreshToken:
      typeof json.refresh_token === 'string' && json.refresh_token
        ? json.refresh_token
        : previousRefreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export function onbaseWorkerRefresh(connector: string): OnBaseRefresh {
  return async (refreshToken) => {
    const answer = await onbaseWorkerCall('token', {
      tenantId: currentTenant(),
      connector,
      grant: { type: 'refresh_token', refreshToken },
    });
    if (!answer.ok) {
      return err<RefreshError>(
        answer.err.message === 'invalid_grant' ? 'GRANT_REVOKED' : 'REFRESH_FAILED'
      );
    }
    const refreshed = refreshedOf(answer.val, refreshToken);
    return refreshed ? ok(refreshed) : err<RefreshError>('REFRESH_FAILED');
  };
}

/*
  The generic ProviderAdapter.refreshTokens(clientId, refreshToken) has no
  tenant parameter; the worker needs one to find the IdP registration. The
  refresh runs inside `withTenant`, which the grant module wraps every
  OnBase refresh in — async-local, so concurrent refreshes for different
  tenants never see each other's — and the adapter contract every other
  provider satisfies stays as it is.
*/
const tenantStore = new AsyncLocalStorage<string>();

export function currentTenant(): string {
  return tenantStore.getStore() ?? '';
}

export function withTenant<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
  return tenantStore.run(tenantId, run);
}
