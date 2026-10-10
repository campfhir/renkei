/**
 * The PHI access trail (migration 141): one row per read, search, export
 * or download against a connector whose content is protected health
 * information — Mirth message stores, OnBase documents, network file
 * shares. `tool_calls` says a tool ran; this says WHICH record it reached,
 * by identifier, so "who looked at message 4711 on the ADT channel, and
 * when" has an answer.
 *
 * Identifiers and hashes only. A row never carries a message body, a
 * document's text, a search's free text, or a file path — a path on a
 * clinical share is as often as not a patient's name, so it is stored as
 * a SHA-256 (`hashPath`) that still lets two reads of the same file be
 * matched. The schema has nowhere to put content (migration 141), which
 * is the point.
 *
 * Recording is awaited but never fatal: the read has already happened by
 * the time this runs, and a trail that failed the read it describes would
 * teach people to turn it off. A failed insert is logged at warn — unlike
 * usage telemetry, a missing PHI access row is something an operator
 * should hear about. The table is append-only (a trigger refuses UPDATE
 * and DELETE), so nothing here ever edits a row.
 */

import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { logger } from '@/lib/logger';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import { currentRunId } from '@/lib/mcp-tools/run-context';

export type PhiConnector = 'mirth' | 'onbase' | 'fileshare';
export type PhiAction = 'read' | 'search' | 'export' | 'download';

export interface PhiAccessInput {
  /** The person whose access this is — a run's OWNER when an agent called. */
  subject: string;
  /** The acting agent, when one did the calling; the run comes from the call's context. */
  agentId?: string | null;
  connector: PhiConnector;
  /** The Mirth instance or file share; absent for OnBase. */
  instanceId?: string | null;
  action: PhiAction;
  toolName: string;
  channelId?: string | null;
  messageId?: string | number | null;
  documentId?: string | null;
  /** Already hashed (`hashPath`); never a path. */
  pathHash?: string | null;
}

/** SHA-256 hex of a share-relative path — what the trail stores instead of the path. */
export function hashPath(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

/** A tool's caller as the trail names them: the owner's subject and the agent, if any. */
export function phiActorOf(
  context: Pick<MCPToolContext, 'subject' | 'agent'>
): { subject: string; agentId: string | null } | null {
  if (!context.subject) return null;
  return {
    subject: context.subject,
    agentId: context.agent?.agentId ?? null,
  };
}

const ID_MAX = 255;
const clipId = (value: string | number | null | undefined, max = ID_MAX): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

/**
 * Write one row. Returns whether it landed; a caller carries on either
 * way (the read already happened), but a test can assert on it.
 */
export async function recordPhiAccess(
  input: PhiAccessInput,
  db: Kysely<DB> | null = null
): Promise<boolean> {
  const dbResult = db ? { ok: true as const, val: db } : getDatabase();
  if (!dbResult.ok) {
    logger.warn('PHI access not recorded: database unavailable', {
      component: 'phi-access',
      tool: input.toolName,
    });
    return false;
  }
  // The run id rides the agent runner's header; it means nothing on a
  // person's own call, so it is taken only when an agent is the caller.
  const runId = input.agentId ? (currentRunId() ?? null) : null;
  try {
    await dbResult.val
      .insertInto('phi_access_events')
      .values({
        subject: input.subject,
        agent_id: input.agentId ?? null,
        run_id: runId,
        connector: input.connector,
        instance_id: input.instanceId ?? null,
        action: input.action,
        tool_name: input.toolName.slice(0, 100),
        channel_id: clipId(input.channelId),
        message_id: clipId(input.messageId, 64),
        document_id: clipId(input.documentId),
        path_hash: clipId(input.pathHash, 64),
      })
      .execute();
    return true;
  } catch (error) {
    logger.warn('PHI access not recorded: {error}', {
      component: 'phi-access',
      subject: input.subject,
      tool: input.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface PhiAccessEventRow {
  id: string;
  subject: string;
  agentId: string | null;
  runId: string | null;
  connector: string;
  instanceId: string | null;
  action: string;
  toolName: string;
  channelId: string | null;
  messageId: string | null;
  documentId: string | null;
  pathHash: string | null;
  createdAt: string;
}

/** The trail for one person, newest first — the operator's view (admin API). */
export async function listPhiAccessEvents(
  db: Kysely<DB>,
  options: { subject?: string; limit?: number; before?: Date } = {}
): Promise<PhiAccessEventRow[]> {
  let query = db
    .selectFrom('phi_access_events')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
  if (options.subject) query = query.where('subject', '=', options.subject);
  if (options.before) query = query.where('created_at', '<', options.before);
  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    agentId: row.agent_id,
    runId: row.run_id,
    connector: row.connector,
    instanceId: row.instance_id,
    action: row.action,
    toolName: row.tool_name,
    channelId: row.channel_id,
    messageId: row.message_id,
    documentId: row.document_id,
    pathHash: row.path_hash,
    createdAt: row.created_at.toISOString(),
  }));
}
