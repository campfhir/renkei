import React from 'react';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import AuditList, { type AuditEventRow } from './audit-list';

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
export default async function AuditPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Unable to connect to the database. Please try again later.
        </p>
      </div>
    );
  }

  const rows = await dbResult.val
    .selectFrom('audit_events')
    .leftJoin('identities', (join) =>
      join
        .onRef('identities.subject', '=', 'audit_events.actor_subject')
        .onRef('identities.tenant_id', '=', 'audit_events.tenant_id')
    )
    .select([
      'audit_events.id as id',
      'audit_events.action as action',
      'audit_events.target_label as target_label',
      'audit_events.details as details',
      'audit_events.created_at as created_at',
      'audit_events.actor_subject as actor_subject',
      'identities.display_name as display_name',
      'identities.email as email',
    ])
    .where('audit_events.tenant_id', '=', tenantRef.id)
    .orderBy('audit_events.created_at', 'desc')
    .limit(200)
    .execute();

  const events: AuditEventRow[] = rows.map((row) => ({
    id: row.id,
    action: row.action,
    targetLabel: row.target_label,
    details:
      typeof row.details === 'object' && row.details !== null && !Array.isArray(row.details)
        ? { ...row.details }
        : null,
    at: new Date(row.created_at).toISOString(),
    actor: row.display_name || row.email || row.actor_subject || 'The platform',
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Audit</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Platform actions in this organization: sign-ins, connector changes and agent changes. Tool
        usage lives on the Tools page. Showing the latest {events.length} events.
      </p>

      {events.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Nothing yet — events appear as people sign in, connect accounts and build agents.
        </div>
      ) : (
        <AuditList events={events} />
      )}
    </div>
  );
}
