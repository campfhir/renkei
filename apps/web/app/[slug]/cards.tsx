import React from 'react';
import { getDatabase } from '@renkei/db';
import CardActions from './card-actions';
import ArchiveAction from './archive-action';

/**
 * The curated-card feed (use case #1's human half): what Renkei suggests,
 * with approve/dismiss one click away. The default view shows the live feed
 * — unarchived cards — while the audit trail survives in full behind the
 * "Show archived" toggle: archiving hides a card, it never deletes one.
 * Dismissing archives in the same stroke, so a dismissed card leaves the
 * feed immediately; executed/failed cards stay until archived by hand.
 *
 * Visibility (migration 041): a card with no owner is tenant-wide — the
 * original shape — while an owned card (a user's or their agent's, over
 * MCP) appears only on that owner's feed. Informational cards render with
 * dismiss as their one control: there is nothing to approve.
 *
 * A component on the home page, not a page of its own: the cards are the
 * home page's content, everything else there is chrome around them.
 */
export default async function ActionableCards({
  tenantId,
  subject,
  showArchived = false,
}: {
  tenantId: string;
  /** The viewer's OIDC subject — what owner-scoped cards are matched on. */
  subject: string;
  showArchived?: boolean;
}): Promise<React.ReactNode> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300">
        Unable to connect to the database. Please try again later.
      </p>
    );
  }

  let query = dbResult.val
    .selectFrom('actionable_items')
    .leftJoin('agents', 'agents.id', 'actionable_items.created_by_agent_id')
    .select([
      'actionable_items.id as id',
      'actionable_items.source as source',
      'actionable_items.kind as kind',
      'actionable_items.status as status',
      'actionable_items.title as title',
      'actionable_items.summary as summary',
      'actionable_items.evidence as evidence',
      'actionable_items.result as result',
      'actionable_items.created_at as created_at',
      'actionable_items.archived_at as archived_at',
      'agents.name as agent_name',
    ])
    .where('actionable_items.tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([
        eb('actionable_items.owner_subject', 'is', null),
        eb('actionable_items.owner_subject', '=', subject),
      ])
    )
    .orderBy('actionable_items.created_at', 'desc')
    .limit(50);
  if (!showArchived) {
    query = query.where('actionable_items.archived_at', 'is', null);
  }
  const items = await query.execute();

  if (items.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {showArchived ? 'Nothing here yet.' : 'Nothing suggested yet.'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div
          key={item.id}
          className={`rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950 ${
            item.archived_at !== null ? 'opacity-70' : ''
          }`}
        >
          <div className="flex justify-between gap-4">
            <strong>{item.title}</strong>
            <span className="whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
              {item.agent_name ? `via ${item.agent_name}` : item.source} · {item.status}
              {item.archived_at !== null && ' · archived'}
            </span>
          </div>
          <p className="my-2 whitespace-pre-wrap text-sm">{item.summary}</p>

          <RelatedEvidence evidence={item.evidence} />

          {item.status === 'suggested' && (
            <CardActions tenantId={tenantId} itemId={item.id} dismissOnly={item.kind === 'info'} />
          )}

          {item.status === 'executed' && <ExecutionResult result={item.result} />}
          {item.status === 'failed' && <ExecutionResult result={item.result} failed />}

          {item.status !== 'suggested' && (
            <ArchiveAction
              tenantId={tenantId}
              itemId={item.id}
              archived={item.archived_at !== null}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Similar prior discussion the pipeline found, already cleared through the
 * live ACL gate for the reporting user at enrichment time.
 */
function RelatedEvidence({ evidence }: { evidence: unknown }): React.ReactNode {
  if (typeof evidence !== 'object' || evidence === null) return null;
  const record: Record<string, unknown> = { ...evidence };
  const related = Array.isArray(record.related) ? record.related : [];
  if (related.length === 0) return null;

  return (
    <div className="my-2 rounded-md bg-gray-100 p-2 dark:bg-gray-900">
      <strong className="text-xs">Similar prior discussion</strong>
      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
        {related.map((entry, index) => {
          if (typeof entry !== 'object' || entry === null) return null;
          const hit: Record<string, unknown> = { ...entry };
          return <li key={index}>{String(hit.excerpt ?? '')}</li>;
        })}
      </ul>
    </div>
  );
}

function ExecutionResult({
  result,
  failed = false,
}: {
  result: unknown;
  failed?: boolean;
}): React.ReactNode {
  if (typeof result !== 'object' || result === null) return null;
  const record: Record<string, unknown> = { ...result };

  if (failed) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300">
        Failed: {String(record.error ?? 'unknown error')}
      </p>
    );
  }
  if (typeof record.url === 'string' && typeof record.issueKey === 'string') {
    return (
      <p className="text-sm">
        Created{' '}
        <a
          href={record.url}
          className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {record.issueKey}
        </a>
      </p>
    );
  }
  return null;
}
