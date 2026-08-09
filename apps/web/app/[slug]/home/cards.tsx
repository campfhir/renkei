import React from 'react';
import { getDatabase } from '@renkei/db';
import CardActions from './card-actions';

/**
 * The curated-card feed (use case #1's human half): what Renkei suggests,
 * with approve/dismiss one click away. Decided items stay listed — the feed
 * doubles as the audit trail of what was suggested and what people did.
 *
 * A component on the home page, not a page of its own: the cards are the
 * home page's content, everything else there is chrome around them.
 */
export default async function ActionableCards({
  tenantId,
}: {
  tenantId: string;
}): Promise<React.ReactNode> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300">
        Unable to connect to the database. Please try again later.
      </p>
    );
  }

  const items = await dbResult.val
    .selectFrom('actionable_items')
    .select(['id', 'source', 'status', 'title', 'summary', 'evidence', 'result', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  if (items.length === 0) {
    return <p className="text-sm text-gray-600 dark:text-gray-400">Nothing suggested yet.</p>;
  }

  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
        >
          <div className="flex justify-between gap-4">
            <strong>{item.title}</strong>
            <span className="whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
              {item.source} · {item.status}
            </span>
          </div>
          <p className="my-2 whitespace-pre-wrap text-sm">{item.summary}</p>

          <RelatedEvidence evidence={item.evidence} />

          {item.status === 'suggested' && <CardActions tenantId={tenantId} itemId={item.id} />}

          {item.status === 'executed' && <ExecutionResult result={item.result} />}
          {item.status === 'failed' && <ExecutionResult result={item.result} failed />}
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
