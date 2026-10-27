import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { json } from '../salesforce-changes/record';
import { JIRA_CHANGES as TABLE, jiraChangeFromRow } from './record';
import type { JiraChangeStore } from './types';

const HOUR_MS = 3_600_000;

export function memoryJiraChanges(tables: MemoryTables): JiraChangeStore {
  const idOf = (id: string) => tables.param(TABLE, 'id', id);
  const live = (expiresAt: Date, now: Date) => expiresAt.getTime() > now.getTime();

  return {
    async create(input) {
      const now = new Date();
      const row = tables.insert(TABLE, {
        subject: input.subject,
        agent_id: input.agentId,
        cloud_id: input.cloudId,
        site_url: input.siteUrl,
        kind: input.kind,
        title: input.title,
        reason: input.reason,
        payload: json(input.payload),
        expires_at: new Date(now.getTime() + input.ttlHours * HOUR_MS),
        created_at: now,
        updated_at: now,
      });
      return jiraChangeFromRow(row);
    },
    async get(id, options = {}) {
      const key = idOf(id);
      const row = tables.first(
        TABLE,
        (r) => r.id === key && (options.subject === undefined || r.subject === options.subject)
      );
      return row ? jiraChangeFromRow(row) : null;
    },
    async list({ limit, subject, pendingOnly }) {
      const now = new Date();
      const rows = tables.select(
        TABLE,
        (r) =>
          (subject === undefined || r.subject === subject) &&
          (!pendingOnly || (r.status === 'pending' && live(r.expires_at, now)))
      );
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit).map(
        jiraChangeFromRow
      );
    },
    async countPending(options = {}) {
      const now = new Date();
      return tables.select(
        TABLE,
        (r) =>
          r.status === 'pending' &&
          live(r.expires_at, now) &&
          (options.subject === undefined || r.subject === options.subject)
      ).length;
    },
    async claim(subject, id) {
      const key = idOf(id);
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
    async finish(id, outcome) {
      const key = idOf(id);
      const now = new Date();
      return (
        tables.update(TABLE, (r) => r.id === key && r.status === 'applying', {
          status: outcome.status,
          results: json(outcome.results),
          applied_by: outcome.appliedBy,
          applied_at: now,
          updated_at: now,
          step: null,
        }).length > 0
      );
    },
    async cancel(id, { subject, resolution }) {
      const key = idOf(id);
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
      const key = idOf(id);
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
      const key = idOf(id);
      return (
        tables.update(TABLE, (r) => r.id === key && r.status === 'queued', {
          status: 'applying',
          updated_at: new Date(),
          step,
        }).length > 0
      );
    },
    async reclaimStale(id, staleMs) {
      const key = idOf(id);
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
      const key = idOf(id);
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
      const key = idOf(id);
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
