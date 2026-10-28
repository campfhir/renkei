import { compareAsc, groupBy, orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { SALESFORCE_CHANGES as TABLE, salesforceChangeFromRow } from './record';
import type { SalesforceChangeStore } from './types';

const HOUR_MS = 3_600_000;

export function memorySalesforceChanges(tables: MemoryTables): SalesforceChangeStore {
  const live = (expiresAt: Date, now: Date) => expiresAt.getTime() > now.getTime();

  return {
    async create(input) {
      const now = new Date();
      const row = tables.insert(TABLE, {
        subject: input.subject,
        agent_id: input.agentId,
        connector_key: input.connectorKey,
        org_id: input.orgId,
        instance_url: input.instanceUrl,
        kind: input.kind,
        title: input.title,
        reason: input.reason,
        payload: toJson(input.payload),
        expires_at: new Date(now.getTime() + input.ttlHours * HOUR_MS),
        id: globalThis.crypto.randomUUID(),
        status: 'pending',
        results: null,
        step: null,
        resolution: null,
        applied_by: null,
        applied_at: null,
        approved_by: null,
        approved_at: null,
        cancelled_at: null,
        validation: null,
        created_at: now,
        updated_at: now,
      });
      return salesforceChangeFromRow(row);
    },
    async setValidation(id, validation) {
      const key = id;
      tables.update(TABLE, (r) => r.id === key, {
        validation: toJson(validation),
        updated_at: new Date(),
      });
    },
    async get(id, options = {}) {
      const key = id;
      const row = tables.first(
        TABLE,
        (r) => r.id === key && (options.subject === undefined || r.subject === options.subject)
      );
      return row ? salesforceChangeFromRow(row) : null;
    },
    async list({ limit, subject, pendingOnly, connectorKey }) {
      const now = new Date();
      const rows = tables.select(
        TABLE,
        (r) =>
          (subject === undefined || r.subject === subject) &&
          (!pendingOnly || (r.status === 'pending' && live(r.expires_at, now))) &&
          (!connectorKey || r.connector_key === connectorKey)
      );
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit).map(
        salesforceChangeFromRow
      );
    },
    async countPendingByConnector(options = {}) {
      const now = new Date();
      const rows = tables.select(
        TABLE,
        (r) =>
          r.status === 'pending' &&
          live(r.expires_at, now) &&
          (options.subject === undefined || r.subject === options.subject)
      );
      return [...groupBy(rows, (r) => r.connector_key)]
        .map(([connectorKey, group]) => ({ connectorKey, count: group.length }))
        .sort((a, b) => compareAsc(a.connectorKey, b.connectorKey));
    },
    async claim(subject, id) {
      const key = id;
      const now = new Date();
      return (
        tables.update(
          TABLE,
          (r) =>
            r.id === key &&
            r.subject === subject &&
            r.status === 'pending' &&
            live(r.expires_at, now),
          { status: 'applying', updated_at: now }
        ).length > 0
      );
    },
    async recordDeployStarted(id, results) {
      const key = id;
      tables.update(TABLE, (r) => r.id === key && r.status === 'applying', {
        results: toJson(results),
        updated_at: new Date(),
      });
    },
    async finish(id, outcome) {
      const key = id;
      const now = new Date();
      return (
        tables.update(TABLE, (r) => r.id === key && r.status === 'applying', {
          status: outcome.status,
          results: toJson(outcome.results),
          applied_by: outcome.appliedBy,
          applied_at: now,
          updated_at: now,
          step: null,
        }).length > 0
      );
    },
    async cancel(id, { subject, resolution }) {
      const key = id;
      const now = new Date();
      return (
        tables.update(
          TABLE,
          (r) =>
            r.id === key &&
            r.status === 'pending' &&
            (subject === undefined || r.subject === subject),
          {
            status: 'cancelled',
            cancelled_at: now,
            updated_at: now,
            ...(resolution !== undefined ? { resolution } : {}),
          }
        ).length > 0
      );
    },
    async queue(id, { approvedBy, step, exceptKind }) {
      const key = id;
      const now = new Date();
      return (
        tables.update(
          TABLE,
          (r) =>
            r.id === key &&
            r.kind !== exceptKind &&
            r.status === 'pending' &&
            live(r.expires_at, now),
          { status: 'queued', approved_by: approvedBy, approved_at: now, updated_at: now, step }
        ).length > 0
      );
    },
    async startQueued(id, step) {
      const key = id;
      return (
        tables.update(TABLE, (r) => r.id === key && r.status === 'queued', {
          status: 'applying',
          updated_at: new Date(),
          step,
        }).length > 0
      );
    },
    async reclaimStale(id, staleMs) {
      const key = id;
      const now = new Date();
      return (
        tables.update(
          TABLE,
          (r) =>
            r.id === key &&
            r.status === 'applying' &&
            r.updated_at.getTime() < now.getTime() - staleMs,
          { updated_at: now }
        ).length > 0
      );
    },
    async setStep(id, step) {
      const key = id;
      return (
        tables.update(
          TABLE,
          (r) => r.id === key && (r.status === 'queued' || r.status === 'applying'),
          { step, updated_at: new Date() }
        ).length > 0
      );
    },
    async listRunnable(staleMs, limit) {
      const cutoff = Date.now() - staleMs;
      const rows = tables.select(
        TABLE,
        (r) => r.status === 'queued' || (r.status === 'applying' && r.updated_at.getTime() < cutoff)
      );
      return page(orderBy(rows, [(r) => r.updated_at], [(r) => r.id]), limit).map((r) => ({
        id: r.id,
        status: r.status === 'queued' ? ('queued' as const) : ('applying' as const),
      }));
    },
    async closeAsProposed(id, { kind, resolution }) {
      const key = id;
      const now = new Date();
      return (
        tables.update(TABLE, (r) => r.id === key && r.kind === kind && r.status === 'pending', {
          status: 'cancelled',
          cancelled_at: now,
          updated_at: now,
          resolution,
        }).length > 0
      );
    },
  };
}
