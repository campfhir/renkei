import React from 'react';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { redirect } from 'next/navigation';
import { getDataStore } from '@renkei/db';
import AuditList, { type AuditEventRow } from './audit-list';
import CoachTarget from '@/components/coach-marks/anchor';

/**
 * The tenant's audit trail (migration 038): who signed in, connected or
 * disconnected what, created or disabled which agent. Platform actions
 * only — tool calls and searches are usage and live on the Tools page.
 *
 * This server component only fetches and joins names; the rendering —
 * sentences under day headings — lives in the AuditList client component,
 * because both the day buckets and the times must be the VIEWER's zone,
 * which the server does not know.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default async function AuditPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  const rows = await getDataStore()
    .auditEvents.listRecent(200)
    .catch(() => null);
  if (!rows) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Unable to connect to the database. Please try again later.
        </p>
      </div>
    );
  }

  const events: AuditEventRow[] = rows.map((row) => ({
    id: row.id,
    action: row.action,
    targetLabel: row.targetLabel,
    details: isRecord(row.details) ? { ...row.details } : null,
    at: row.createdAt.toISOString(),
    actor: row.actorDisplayName || row.actorEmail || row.actorSubject || 'The platform',
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Audit</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Platform actions in this organization: sign-ins, connector changes and agent changes. Tool
        usage lives on the Tools page. Showing the latest {events.length} events.
      </p>

      <CoachTarget name="admin-audit-list">
        {events.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
            Nothing yet — events appear as people sign in, connect accounts and build agents.
          </div>
        ) : (
          <AuditList events={events} />
        )}
      </CoachTarget>
    </div>
  );
}
