import React from 'react';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { friendlyToolName, parseFormNodes, type FormNode } from '@renkei/agents';
import { Icon, ICONS } from '@/components/icons';
import CardActions from './card-actions';
import ApprovalActions from './approval-actions';
import QuestionActions from './question-actions';
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
  slug,
  subject,
  showArchived = false,
}: {
  tenantId: string;
  /** The tenant's URL slug — approval cards link to their paused run. */
  slug: string;
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
      'actionable_items.suggested_action as suggested_action',
      'actionable_items.run_id as run_id',
      'actionable_items.created_by_agent_id as agent_id',
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
      {items.map((item) => {
        const isPause = item.kind === 'approval' || item.kind === 'question';
        return (
          <div
            key={item.id}
            className={`rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950 ${
              item.archived_at !== null ? 'opacity-70' : ''
            }`}
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
              <strong className="min-w-0 break-words">
                {isPause && item.status === 'suggested' ? (
                  <PauseKindChip kind={item.kind === 'question' ? 'question' : 'approval'} />
                ) : null}
                {item.title}
              </strong>
              <span className="text-sm text-gray-500 dark:text-gray-400 sm:whitespace-nowrap">
                {item.agent_name ? `via ${item.agent_name}` : item.source} · {item.status}
                {item.archived_at !== null && ' · archived'}
              </span>
            </div>
            <p className="my-2 whitespace-pre-wrap text-sm">{item.summary}</p>

            <RelatedEvidence evidence={item.evidence} />

            {item.kind === 'approval' && <ProposedCall suggestedAction={item.suggested_action} />}

            {isPause && item.run_id && item.agent_id ? (
              <p className="mb-2 text-sm">
                <Link
                  href={`/${slug}/agents/${item.agent_id}/runs/${item.run_id}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  View the paused run →
                </Link>
              </p>
            ) : null}

            {item.status === 'suggested' &&
              (item.kind === 'approval' ? (
                // No dismiss here: declining is the "no", and doing nothing
                // lets the wait treat it as not approved.
                <ApprovalActions tenantId={tenantId} itemId={item.id} />
              ) : item.kind === 'question' ? (
                <QuestionActions
                  tenantId={tenantId}
                  itemId={item.id}
                  form={questionFormFrom(item.suggested_action)}
                />
              ) : (
                <CardActions
                  tenantId={tenantId}
                  itemId={item.id}
                  dismissOnly={item.kind === 'info'}
                />
              ))}

            {isPause && item.status !== 'suggested' && (
              <PauseOutcome
                kind={item.kind === 'question' ? 'question' : 'approval'}
                status={item.status}
                result={item.result}
              />
            )}
            {item.status === 'executed' && <ExecutionResult result={item.result} />}
            {item.status === 'failed' && <ExecutionResult result={item.result} failed />}

            {item.status !== 'suggested' && !isPause && (
              <ArchiveAction
                tenantId={tenantId}
                itemId={item.id}
                archived={item.archived_at !== null}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The form an ask_person call snapshotted onto its card. */
function questionFormFrom(suggestedAction: unknown): FormNode[] {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return [];
  const record: { form?: unknown } = { ...suggestedAction };
  return parseFormNodes(record.form);
}

/**
 * The proposed call a `needsApproval` gate's card shows — never an
 * authored message, since there is nothing to author: the point of the
 * flag is "gate whatever this step is about to do." Shown only while the
 * card is still undecided; a decided one's outcome line below covers it.
 */
function ProposedCall({ suggestedAction }: { suggestedAction: unknown }): React.ReactNode {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return null;
  const record: { tool?: unknown; args?: unknown } = { ...suggestedAction };
  if (typeof record.tool !== 'string') return null;
  const args =
    typeof record.args === 'object' && record.args !== null && !Array.isArray(record.args)
      ? { ...record.args }
      : {};
  const entries = Object.entries(args);
  return (
    <div className="my-2 rounded-md bg-gray-100 p-2 text-xs dark:bg-gray-900">
      <strong>Wants to call {friendlyToolName(record.tool, null)}</strong>
      {entries.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-gray-600 dark:text-gray-400">
          {entries.map(([key, value]) => (
            <li key={key} className="break-words">
              <span className="font-mono">{key}</span>: {String(value)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Which KIND of pause this is, before anyone reads a word of the card.
 *
 * An approval wants a verdict on an act already specified; a question
 * wants a fact the agent could not determine — and in a feed they were
 * indistinguishable until you scrolled to the controls: same title shape,
 * same "via <agent> · suggested". Someone triaging six cards decides in
 * what order to open them from this line, so the line has to carry it.
 *
 * Only on an undecided card: a decided one renders its outcome underneath,
 * which is the more useful thing to say about it, and a "needs your
 * answer" chip above that would just be stale.
 */
function PauseKindChip({ kind }: { kind: 'approval' | 'question' }): React.ReactNode {
  const asking = kind === 'question';
  return (
    <span
      className={`mr-2 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 align-middle text-xs font-medium ${
        asking
          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
          : 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
      }`}
    >
      <Icon path={asking ? ICONS.question : ICONS.approval} className="h-3.5 w-3.5" />
      {asking ? 'Answer needed' : 'Approval needed'}
    </span>
  );
}

/** What happened to a decided approval or question card — the feed's audit line. */
function PauseOutcome({
  kind,
  status,
  result,
}: {
  kind: 'approval' | 'question';
  status: string;
  result: unknown;
}): React.ReactNode {
  const record: Record<string, unknown> =
    typeof result === 'object' && result !== null ? { ...result } : {};
  const wording =
    kind === 'question'
      ? status === 'answered'
        ? 'You answered — the run continued.'
        : record.reason === 'run-ended' || record.reason === 'agent-disabled'
          ? 'The run ended before anyone answered.'
          : 'Nobody answered in time — the run treated it as unanswered.'
      : status === 'approved'
        ? typeof record.comment === 'string' && record.comment
          ? `You approved: ${record.comment}`
          : 'You approved — the run continued.'
        : status === 'declined'
          ? typeof record.comment === 'string' && record.comment
            ? `You declined: ${record.comment}`
            : 'You declined.'
          : record.reason === 'run-ended' || record.reason === 'agent-disabled'
            ? 'The run ended before anyone decided.'
            : 'Nobody decided in time — the run treated it as not approved.';
  return <p className="whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400">{wording}</p>;
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
          return (
            <li key={index} className="break-words">
              {String(hit.excerpt ?? '')}
            </li>
          );
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
