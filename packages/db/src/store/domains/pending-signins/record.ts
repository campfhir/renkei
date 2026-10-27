import type { Selectable } from 'kysely';
import type { PendingOidcSignin } from '../../../db.types';
import type { PendingSigninInput, PendingSigninRecord } from './types';

export function pendingSigninFromRow(row: Selectable<PendingOidcSignin>): PendingSigninRecord {
  return {
    state: row.state,
    nonce: row.nonce,
    subject: row.subject,
    provider: row.provider,
    scopes: row.scopes,
    codeVerifier: row.code_verifier,
    connectorKey: row.connector_key,
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * The row to insert. Timestamps go as ISO text, the way the routes this
 * replaced wrote them: the columns are `timestamp` (no zone), so Postgres
 * keeps the UTC wall-clock and pg reads it back in the process's zone.
 */
export function pendingSigninValues(pending: PendingSigninInput) {
  return {
    id: pending.id,
    state: pending.state,
    nonce: pending.nonce,
    subject: pending.subject ?? null,
    provider: pending.provider ?? null,
    scopes: pending.scopes ?? null,
    code_verifier: pending.codeVerifier ?? null,
    connector_key: pending.connectorKey ?? null,
    expires_at: pending.expiresAt.toISOString(),
    created_at: (pending.createdAt ?? new Date()).toISOString(),
  };
}
