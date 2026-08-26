/**
 * Run tokens: how the agents worker becomes "the owner" at the MCP endpoint.
 *
 * A token is minted per run — application 'agent' (RENKEI.md Decision #21),
 * bound to the run owner's subject, TTL a little past the run timeout —
 * and revoked at run end, TTL as the backstop. Only the SHA-256 digest is
 * stored, with the exact digest the web app verifies (@renkei/crypto).
 *
 * oauth_access_tokens.client_id has an FK to oauth_clients, so each tenant
 * gets one synthetic client row. Its secret hash is a random digest nobody
 * holds the preimage of: the row exists to satisfy the FK and name the
 * token's provenance, never to authenticate anything itself.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { generateSecret, sha256Hex } from '@renkei/crypto';

function runnerClientId(tenantId: string): string {
  // client_id is a GLOBAL primary key, so the tenant is part of the name.
  return `agent-runner-${tenantId}`;
}

export async function ensureAgentRunnerClient(db: Kysely<DB>, tenantId: string): Promise<string> {
  const clientId = runnerClientId(tenantId);
  await db
    .insertInto('oauth_clients')
    .values({
      client_id: clientId,
      tenant_id: tenantId,
      client_name: 'Renkei agent runner',
      // A hash with no known preimage — this client never authenticates.
      client_secret_hash: sha256Hex(generateSecret(32)),
      redirect_uris: [],
    })
    .onConflict((oc) => oc.column('client_id').doNothing())
    .execute();
  return clientId;
}

export async function mintRunToken(
  db: Kysely<DB>,
  params: {
    tenantId: string;
    subject: string;
    /**
     * The acting agent, or null when the work is the PERSON's rather than an
     * agent's — drafting from prose is the case: there is usually no agent
     * yet, and even when revising one the draft is the author's own work.
     */
    agentId: string | null;
    ttlSeconds: number;
  }
): Promise<string> {
  const clientId = await ensureAgentRunnerClient(db, params.tenantId);
  const token = generateSecret(32);
  await db
    .insertInto('oauth_access_tokens')
    .values({
      token_hash: sha256Hex(token),
      tenant_id: params.tenantId,
      client_id: clientId,
      subject: params.subject,
      application: 'agent',
      // The acting agent (migration 040): the subject says WHOSE authority
      // the run borrows; agent_id says WHO is borrowing it, so tools can
      // stamp agent provenance without weakening the owner-scoped gates.
      agent_id: params.agentId,
      scope: null,
      expires_at: new Date(Date.now() + params.ttlSeconds * 1000),
    })
    .execute();
  return token;
}

/** Best effort — the TTL already bounds a missed revocation. */
export async function revokeRunToken(db: Kysely<DB>, token: string): Promise<void> {
  try {
    await db.deleteFrom('oauth_access_tokens').where('token_hash', '=', sha256Hex(token)).execute();
  } catch {
    // The row expires on its own.
  }
}
