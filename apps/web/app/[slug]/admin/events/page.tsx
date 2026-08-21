import React from 'react';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import type { Json } from '@renkei/db';
import EventsList, { type EventRow, type EventStatus } from './events-list';

/**
 * The event monitor: every webhook delivery and internal event, its source,
 * who it belongs to, where it was handed off, and how it resolved —
 * queued / processing / processed / skipped / retrying / failed.
 *
 * Deliberately detail-free: no payloads, no error bodies. The queue rows
 * (migration 013) already carry everything shown here; failed events live in
 * the dead-letter table, so the page reads both. "Skipped" is a handler's own
 * verdict (no grant on file, stale notification, feature off) — completed
 * without doing work, distinct from processed so silence is never mistaken
 * for success.
 */

/** The payload fields that name an owner, read without disclosing content. */
function actorHintOf(payload: Json): { accountId?: string; subject?: string; email?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
  const record: Record<string, unknown> = payload;
  if (typeof record.accountId === 'string' && record.accountId) {
    return { accountId: record.accountId };
  }
  // Domain events carry the owner subject directly.
  if (typeof record.ownerSubject === 'string' && record.ownerSubject) {
    return { subject: record.ownerSubject };
  }
  // Zoom deliveries are the raw webhook body: payload.object.host_email.
  const inner = record.payload;
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
    const object: unknown = Reflect.get(inner, 'object');
    if (typeof object === 'object' && object !== null && !Array.isArray(object)) {
      const hostEmail: unknown = Reflect.get(object, 'host_email');
      if (typeof hostEmail === 'string' && hostEmail) return { email: hostEmail };
    }
  }
  return {};
}

function statusOf(status: string, attempts: number): EventStatus {
  if (status === 'pending') return attempts > 0 ? 'retrying' : 'queued';
  if (status === 'processing') return 'processing';
  if (status === 'skipped') return 'skipped';
  return 'processed';
}

export default async function EventsPage({
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
  const db = dbResult.val;

  const LIMIT = 200;
  // A named constant, not an inline literal: object-literal widening would
  // otherwise erase the EventStatus type in the merge below.
  const failedStatus: EventStatus = 'failed';
  const [liveRows, deadRows] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'source', 'type', 'status', 'attempts', 'payload', 'created_at'])
      .where('tenant_id', '=', tenantRef.id)
      .orderBy('created_at', 'desc')
      .limit(LIMIT)
      .execute(),
    db
      .selectFrom('events_dead_letters')
      .select(['id', 'source', 'type', 'attempts', 'payload', 'created_at'])
      .where('tenant_id', '=', tenantRef.id)
      .orderBy('created_at', 'desc')
      .limit(LIMIT)
      .execute(),
  ]);

  const merged = [
    ...liveRows.map((row) => ({
      id: row.id,
      source: row.source,
      type: row.type,
      status: statusOf(row.status, row.attempts),
      attempts: row.attempts,
      hint: actorHintOf(row.payload),
      receivedAt: new Date(row.created_at),
    })),
    ...deadRows.map((row) => ({
      id: row.id,
      source: row.source,
      type: row.type,
      status: failedStatus,
      attempts: row.attempts,
      hint: actorHintOf(row.payload),
      receivedAt: new Date(row.created_at),
    })),
  ]
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, LIMIT);

  // Owner display names, best effort: provider account ids resolve through
  // provider_grants to a subject, subjects through identities to an email.
  // A hint that resolves to nothing still shows raw rather than '—': an
  // admin chasing one user's missing events needs SOMETHING to match on.
  const accountIds = [...new Set(merged.flatMap((row) => row.hint.accountId ?? []))];
  const grantRows = accountIds.length
    ? await db
        .selectFrom('provider_grants')
        .select(['provider_account_id', 'subject'])
        .where('tenant_id', '=', tenantRef.id)
        .where('provider_account_id', 'in', accountIds)
        .execute()
    : [];
  const subjectByAccount = new Map(grantRows.map((row) => [row.provider_account_id, row.subject]));

  const subjects = [
    ...new Set(
      merged.flatMap((row) => {
        const viaAccount = row.hint.accountId
          ? (subjectByAccount.get(row.hint.accountId) ?? null)
          : null;
        return [
          ...(viaAccount ? [viaAccount] : []),
          ...(row.hint.subject ? [row.hint.subject] : []),
        ];
      })
    ),
  ];
  const identityRows = subjects.length
    ? await db
        .selectFrom('identities')
        .select(['subject', 'email', 'display_name'])
        .where('tenant_id', '=', tenantRef.id)
        .where('subject', 'in', subjects)
        .execute()
    : [];
  const identityBySubject = new Map(identityRows.map((row) => [row.subject, row]));

  const events: EventRow[] = merged.map((row) => {
    const subject =
      row.hint.subject ??
      (row.hint.accountId ? (subjectByAccount.get(row.hint.accountId) ?? null) : null);
    const identity = subject ? identityBySubject.get(subject) : undefined;
    return {
      id: row.id,
      source: row.source,
      type: row.type,
      status: row.status,
      attempts: row.attempts,
      user:
        identity?.email ??
        identity?.display_name ??
        row.hint.email ??
        row.hint.accountId ??
        subject ??
        null,
      receivedAt: row.receivedAt.toISOString(),
    };
  });

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Events</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Incoming webhooks and internal events: where each came from, who it belongs to, where it was
        handed off, and how it resolved. Showing the latest {events.length}.
      </p>

      {events.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Nothing yet — events appear as connected providers deliver webhooks.
        </div>
      ) : (
        <EventsList events={events} />
      )}
    </div>
  );
}
