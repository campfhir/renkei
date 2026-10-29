/**
 * Run tokens: how a server-side process becomes "the person" at the MCP
 * endpoint — the agents worker for a run, the web app for a chat turn.
 *
 * A token is minted per unit of work — application 'agent' (RENKEI.md
 * Decision #21), bound to the person's subject, TTL a little past the
 * work's own timeout — and revoked at the end, TTL as the backstop. Only
 * the SHA-256 digest is stored, with the exact digest the web app verifies
 * (@renkei/crypto). The person's renkei roles ride along (migration 091)
 * so a role-gated tool answers the same way it would for their browser.
 *
 * A second class, application 'widget', is minted ONLY by the chat's
 * widget-card confirm path (apps/web/lib/chat/widget-tools.ts) for the one
 * `*_confirm` tool a card's button names. The gateway registers app-only
 * tools (`_meta.ui.visibility: ['app']`) for this class alone — every
 * other token, 'agent' included, never sees or reaches them — so the
 * provenance of a confirm call is the token's class, not a description
 * guard a client may ignore.
 *
 * oauth_access_tokens.client_id has an FK to oauth_clients, so each tenant
 * gets one synthetic client row. Its secret hash is a random digest nobody
 * holds the preimage of: the row exists to satisfy the FK and name the
 * token's provenance, never to authenticate anything itself.
 */

import { getDataStore } from '@renkei/db';
import { generateSecret, sha256Hex } from '@renkei/crypto';

/** The two token classes this module mints — see the header. */
export type RunTokenApplication = 'agent' | 'widget';

function runnerClientId(): string {
  return 'agent-runner';
}

export async function ensureAgentRunnerClient(): Promise<string> {
  const clientId = runnerClientId();
  await getDataStore().runTokens.ensureClient({
    clientId,
    clientName: 'Renkei agent runner',
    // A hash with no known preimage — this client never authenticates.
    secretHash: sha256Hex(generateSecret(32)),
  });
  return clientId;
}

export async function mintRunToken(params: {
  subject: string;
  /**
   * The acting agent, or null when the work is the PERSON's rather than an
   * agent's — a chat turn, or drafting from prose: there is usually no
   * agent yet, and even when revising one the draft is the author's own
   * work.
   */
  agentId: string | null;
  ttlSeconds: number;
  /** The person's renkei roles; omitted = none (the pre-091 behavior). */
  roles?: string[];
  /**
   * The only tools this token may see or call (migration 096) — an
   * agent run passes every tool its steps name. Omitted = unrestricted,
   * the surface a chat turn or a draft has always had.
   */
  tools?: readonly string[];
  /**
   * The token's class. 'agent' (the default) is a run or a chat turn;
   * 'widget' is a preview card's confirm button and is the ONLY class
   * the gateway registers app-only confirm tools for. A 'widget' token
   * must also name its one tool in `tools`.
   */
  application?: RunTokenApplication;
  /**
   * The sandbox scratch space the token's sandbox tools stage in and read
   * from (migration 169): `chat:<id>` for a chat turn, `project:<id>` for
   * a code project's. Omitted = the person's own scratch space.
   */
  sandboxScope?: string;
}): Promise<string> {
  const clientId = await ensureAgentRunnerClient();
  const token = generateSecret(32);
  await getDataStore().runTokens.insert({
    tokenHash: sha256Hex(token),
    clientId,
    subject: params.subject,
    application: params.application ?? 'agent',
    // The acting agent (migration 040): the subject says WHOSE authority
    // the run borrows; agent_id says WHO is borrowing it, so tools can
    // stamp agent provenance without weakening the owner-scoped gates.
    agentId: params.agentId,
    scope: null,
    ...(params.roles ? { roles: params.roles } : {}),
    toolNames: params.tools ? [...new Set(params.tools)].sort() : null,
    sandboxScope: params.sandboxScope ?? null,
    expiresAt: new Date(Date.now() + params.ttlSeconds * 1000),
  });
  return token;
}

/** Best effort — the TTL already bounds a missed revocation. */
export async function revokeRunToken(token: string): Promise<void> {
  try {
    await getDataStore().runTokens.delete(sha256Hex(token));
  } catch {
    // The row expires on its own.
  }
}
