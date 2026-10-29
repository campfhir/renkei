import type { Kysely, Selectable } from 'kysely';
import type { DB, PhiAccessEvents } from '../../../db.types';
import type { NewPhiAccessEvent, PhiAccessEventRecord, PhiAccessStore } from './types';

export function phiEventFromRow(row: Selectable<PhiAccessEvents>): PhiAccessEventRecord {
  return {
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
    createdAt: new Date(row.created_at),
  };
}

export function phiEventValues(event: NewPhiAccessEvent) {
  return {
    subject: event.subject,
    agent_id: event.agentId,
    run_id: event.runId,
    connector: event.connector,
    instance_id: event.instanceId,
    action: event.action,
    tool_name: event.toolName,
    channel_id: event.channelId,
    message_id: event.messageId,
    document_id: event.documentId,
    path_hash: event.pathHash,
  };
}

export function postgresPhiAccess(db: () => Kysely<DB>): PhiAccessStore {
  return {
    async record(event) {
      await db().insertInto('phi_access_events').values(phiEventValues(event)).execute();
    },
    async list({ subject, limit, before }) {
      let query = db()
        .selectFrom('phi_access_events')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit);
      if (subject) query = query.where('subject', '=', subject);
      if (before) query = query.where('created_at', '<', before);
      return (await query.execute()).map(phiEventFromRow);
    },
  };
}
