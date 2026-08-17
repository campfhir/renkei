import React from 'react';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { grantProviderLabel } from '@/lib/provider-labels';

/**
 * The tenant's audit trail (migration 038): who signed in, connected or
 * disconnected what, created or disabled which agent. Platform actions
 * only — tool calls and searches are usage and live on the Tools page.
 *
 * Rendered as sentences under day headings rather than an id table: an
 * operator reads this to answer "what changed and who did it", and
 * "Casey disconnected Microsoft 365" answers that where a row of
 * truncated uuids never did. Wraps cleanly on a phone for the same
 * reason — a sentence flows, a five-column table scrolls sideways.
 */

/** action + target → the sentence's predicate; the actor is the subject. */
function describe(event: {
  action: string;
  target_label: string | null;
  details: unknown;
}): string {
  const details: { byAdmin?: unknown; account?: unknown } =
    typeof event.details === 'object' && event.details !== null ? event.details : {};
  const byAdmin = details.byAdmin === true;
  const connector = grantProviderLabel(event.target_label ?? '');
  const agent = event.target_label ?? 'an agent';

  switch (event.action) {
    case 'user.signed_in':
      return 'signed in';
    case 'user.signed_out':
      return 'signed out';
    case 'connector.connected':
      return `connected ${connector}`;
    case 'connector.disconnected':
      return byAdmin
        ? `disconnected ${connector} for ${typeof details.account === 'string' ? details.account : 'a user'}`
        : `disconnected ${connector}`;
    case 'agent.created':
      return `created agent “${agent}”`;
    case 'agent.updated':
      return `edited agent “${agent}”`;
    case 'agent.enabled':
      return `turned on agent “${agent}”`;
    case 'agent.disabled':
      return byAdmin ? `turned off agent “${agent}” (admin action)` : `turned off agent “${agent}”`;
    case 'agent.deleted':
      return `deleted agent “${agent}”`;
    default:
      return event.action;
  }
}

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

  const events = await dbResult.val
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

  // Day buckets, newest first — the shape "what happened yesterday" reads in.
  const byDay = new Map<string, typeof events>();
  for (const event of events) {
    const day = new Date(event.created_at).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const bucket = byDay.get(day);
    if (bucket) bucket.push(event);
    else byDay.set(day, [event]);
  }

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
        <div className="space-y-6">
          {[...byDay.entries()].map(([day, dayEvents]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-semibold text-gray-500">{day}</h2>
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-900 dark:border-gray-800 dark:bg-gray-950">
                {dayEvents.map((event) => {
                  const actor =
                    event.display_name || event.email || event.actor_subject || 'The platform';
                  return (
                    <li
                      key={event.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{actor}</span> {describe(event)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-gray-500">
                        {new Date(event.created_at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
