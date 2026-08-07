import React from 'react';
import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import CardActions from './card-actions';

/**
 * The curated-card feed (use case #1's human half): what Renkei suggests,
 * with approve/dismiss one click away. Decided items stay listed — the feed
 * doubles as the audit trail of what was suggested and what people did.
 */
export default async function CardsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}): Promise<React.ReactNode> {
  const { tenantId } = await params;

  const session = await getSessionFromCookies(tenantId);
  if (!session) {
    redirect(signInUrl(tenantId, `/tenant/${tenantId}/cards`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div style={{ padding: '2rem', maxWidth: '800px' }}>
        <h2>Error</h2>
        <p>Unable to connect to the database. Please try again later.</p>
      </div>
    );
  }

  const items = await dbResult.val
    .selectFrom('actionable_items')
    .select(['id', 'source', 'status', 'title', 'summary', 'evidence', 'result', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  return (
    <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>Actionable items</h1>
      <p style={{ color: '#666', marginBottom: '1.5rem' }}>
        Suggestions from your connected tools. Approving executes the action as you.
      </p>

      {items.length === 0 && <p>Nothing suggested yet.</p>}

      {items.map((item) => (
        <div
          key={item.id}
          style={{
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
            <strong>{item.title}</strong>
            <span style={{ color: '#666', whiteSpace: 'nowrap' }}>
              {item.source} · {item.status}
            </span>
          </div>
          <p style={{ margin: '0.5rem 0', whiteSpace: 'pre-wrap' }}>{item.summary}</p>

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
    <div style={{ margin: '0.5rem 0', padding: '0.5rem', background: '#f7f7f7', borderRadius: '6px' }}>
      <strong style={{ fontSize: '0.85rem' }}>Similar prior discussion</strong>
      <ul style={{ margin: '0.25rem 0 0 1rem', fontSize: '0.85rem', color: '#444' }}>
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
    return <p style={{ color: '#b00' }}>Failed: {String(record.error ?? 'unknown error')}</p>;
  }
  if (typeof record.url === 'string' && typeof record.issueKey === 'string') {
    return (
      <p>
        Created <a href={record.url}>{record.issueKey}</a>
      </p>
    );
  }
  return null;
}
