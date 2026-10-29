import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { SALESFORCE_CHANGES as TABLE, json, salesforceChangeFromRow } from './record';
import type { SalesforceChangeStore } from './types';

const changed = (result: { numUpdatedRows?: bigint }) => Number(result.numUpdatedRows ?? 0) > 0;

export function postgresSalesforceChanges(db: () => Kysely<DB>): SalesforceChangeStore {
  return {
    async create(input) {
      const row = await db()
        .insertInto(TABLE)
        .values({
          subject: input.subject,
          agent_id: input.agentId,
          connector_key: input.connectorKey,
          org_id: input.orgId,
          instance_url: input.instanceUrl,
          kind: input.kind,
          title: input.title,
          reason: input.reason,
          payload: json(input.payload),
          expires_at: sql<Date>`NOW() + (${input.ttlHours} * INTERVAL '1 hour')`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return salesforceChangeFromRow(row);
    },
    async setValidation(id, validation) {
      await db()
        .updateTable(TABLE)
        .set({ validation: json(validation), updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async get(id, options = {}) {
      let query = db().selectFrom(TABLE).selectAll().where('id', '=', id);
      if (options.subject !== undefined) query = query.where('subject', '=', options.subject);
      const row = await query.executeTakeFirst();
      return row ? salesforceChangeFromRow(row) : null;
    },
    async list({ limit, subject, pendingOnly, connectorKey }) {
      let query = db().selectFrom(TABLE).selectAll();
      if (subject !== undefined) query = query.where('subject', '=', subject);
      if (pendingOnly) {
        query = query.where('status', '=', 'pending').where('expires_at', '>', sql<Date>`NOW()`);
      }
      if (connectorKey) query = query.where('connector_key', '=', connectorKey);
      const rows = await query.orderBy('created_at', 'desc').orderBy('id').limit(limit).execute();
      return rows.map(salesforceChangeFromRow);
    },
    async countPendingByConnector(options = {}) {
      let query = db()
        .selectFrom(TABLE)
        .select(['connector_key', (eb) => eb.fn.countAll<string>().as('count')])
        .where('status', '=', 'pending')
        .where('expires_at', '>', sql<Date>`NOW()`);
      if (options.subject !== undefined) query = query.where('subject', '=', options.subject);
      const rows = await query.groupBy('connector_key').orderBy('connector_key').execute();
      return rows.map((row) => ({ connectorKey: row.connector_key, count: Number(row.count) }));
    },
    async claim(subject, id) {
      const result = await db()
        .updateTable(TABLE)
        .set({ status: 'applying', updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('subject', '=', subject)
        .where('status', '=', 'pending')
        .where('expires_at', '>', sql<Date>`NOW()`)
        .executeTakeFirst();
      return changed(result);
    },
    async recordDeployStarted(id, results) {
      await db()
        .updateTable(TABLE)
        .set({ results: json(results), updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('status', '=', 'applying')
        .execute();
    },
    async finish(id, outcome) {
      const result = await db()
        .updateTable(TABLE)
        .set({
          status: outcome.status,
          results: json(outcome.results),
          applied_by: outcome.appliedBy,
          applied_at: sql<Date>`NOW()`,
          updated_at: sql<Date>`NOW()`,
          step: null,
        })
        .where('id', '=', id)
        .where('status', '=', 'applying')
        .executeTakeFirst();
      return changed(result);
    },
    async cancel(id, { subject, resolution }) {
      let query = db()
        .updateTable(TABLE)
        .set({
          status: 'cancelled',
          cancelled_at: sql<Date>`NOW()`,
          updated_at: sql<Date>`NOW()`,
          ...(resolution !== undefined ? { resolution } : {}),
        })
        .where('id', '=', id)
        .where('status', '=', 'pending');
      if (subject !== undefined) query = query.where('subject', '=', subject);
      return changed(await query.executeTakeFirst());
    },
    async queue(id, { approvedBy, step, exceptKind }) {
      const result = await db()
        .updateTable(TABLE)
        .set({
          status: 'queued',
          approved_by: approvedBy,
          approved_at: sql<Date>`NOW()`,
          updated_at: sql<Date>`NOW()`,
          step,
        })
        .where('id', '=', id)
        .where('kind', '<>', exceptKind)
        .where('status', '=', 'pending')
        .where('expires_at', '>', sql<Date>`NOW()`)
        .executeTakeFirst();
      return changed(result);
    },
    async startQueued(id, step) {
      const result = await db()
        .updateTable(TABLE)
        .set({ status: 'applying', updated_at: sql<Date>`NOW()`, step })
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      return changed(result);
    },
    async reclaimStale(id, staleMs) {
      const result = await db()
        .updateTable(TABLE)
        .set({ updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('status', '=', 'applying')
        .where('updated_at', '<', sql<Date>`NOW() - (${staleMs} * INTERVAL '1 millisecond')`)
        .executeTakeFirst();
      return changed(result);
    },
    async setStep(id, step) {
      const result = await db()
        .updateTable(TABLE)
        .set({ step, updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('status', 'in', ['queued', 'applying'])
        .executeTakeFirst();
      return changed(result);
    },
    async listRunnable(staleMs, limit) {
      const rows = await db()
        .selectFrom(TABLE)
        .select(['id', 'status'])
        .where((eb) =>
          eb.or([
            eb('status', '=', 'queued'),
            eb.and([
              eb('status', '=', 'applying'),
              eb('updated_at', '<', sql<Date>`NOW() - (${staleMs} * INTERVAL '1 millisecond')`),
            ]),
          ])
        )
        .orderBy('updated_at', 'asc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        status: row.status === 'queued' ? ('queued' as const) : ('applying' as const),
      }));
    },
    async closeAsProposed(id, { kind, resolution }) {
      const result = await db()
        .updateTable(TABLE)
        .set({
          status: 'cancelled',
          cancelled_at: sql<Date>`NOW()`,
          updated_at: sql<Date>`NOW()`,
          resolution,
        })
        .where('id', '=', id)
        .where('kind', '=', kind)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return changed(result);
    },
  };
}
