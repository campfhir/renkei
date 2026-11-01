import React from 'react';
import Link from 'next/link';
import {
  executionResultView,
  pauseOutcomeWording,
  proposedActions,
  questionFormFrom,
  relatedExcerpts,
  type FieldRow,
  type ProposedCallView,
} from './cards.model';
import { Icon, ICONS } from '@/components/icons';
import ExternalLink from '@/components/external-link';
import CardActions from './card-actions';
import ApprovalActions from './approval-actions';
import QuestionActions from './question-actions';
import ArchiveAction from './archive-action';

/** One row of the feed query (page.tsx) — exactly what a card needs to render. */
export interface ActionableItemRow {
  id: string;
  source: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  evidence: unknown;
  result: unknown;
  suggested_action: unknown;
  run_id: string | null;
  agent_id: string | null;
  archived_at: Date | null;
  agent_name: string | null;
}

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
 *
 * Pure rendering, one page's worth of already-fetched rows — the query
 * (paged, PAGE_SIZE at a time — see page.tsx) lives in the server page
 * alongside the pager, which needs the same "is there another page?"
 * answer the query produces.
 */
export default function ActionableCards({
  items,
  showArchived = false,
}: {
  items: ActionableItemRow[];
  /** Whose feed this is — every decision on these cards requires the
   * card's owner_subject to match it (server-side). */
  subject: string;
  showArchived?: boolean;
}): React.ReactNode {
  if (items.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {showArchived ? 'Nothing here yet.' : 'Nothing suggested yet.'}
      </p>
    );
  }

  const cards: React.ReactNode[] = [];
  for (const item of items) {
    const isPause = item.kind === 'approval' || item.kind === 'question';
    cards.push(
      <div
        key={item.id}
        role="article"
        aria-label={item.title}
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
        <p className="my-2 whitespace-pre-wrap break-words text-sm">{item.summary}</p>

        <RelatedEvidence evidence={item.evidence} />

        {item.kind === 'approval' && <ProposedBatch suggestedAction={item.suggested_action} />}

        {isPause && item.run_id && item.agent_id ? (
          <p className="mb-2 text-sm">
            <Link
              href={`/agents/${item.agent_id}/runs/${item.run_id}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              View the paused run →
            </Link>
          </p>
        ) : null}

        {item.status === 'suggested' &&
          (item.kind === 'approval' ? (
            // No dismiss here: declining is the "no", and doing nothing
            // lets the wait treat it as not accepted.
            <ApprovalActions itemId={item.id} />
          ) : item.kind === 'question' ? (
            <QuestionActions itemId={item.id} form={questionFormFrom(item.suggested_action)} />
          ) : (
            <CardActions itemId={item.id} dismissOnly={item.kind === 'info'} />
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
          <ArchiveAction itemId={item.id} archived={item.archived_at !== null} />
        )}
      </div>
    );
  }

  return <div className="space-y-4">{cards}</div>;
}

/**
 * The batch of staged actions an agent proposed — the card's whole point.
 * Accepting (ApprovalActions, below it) accepts every action, in this
 * order; nothing runs from here: a separate executor makes the calls and
 * reports each outcome back to the agent. Each action reads as what it
 * would do and why, with its arguments behind a disclosure — laid out by
 * cards.model.ts for its tool family.
 */
function ProposedBatch({ suggestedAction }: { suggestedAction: unknown }): React.ReactNode {
  const actions = proposedActions(suggestedAction);
  if (actions.length === 0) return null;
  return (
    <ol aria-label="Proposed actions" className="my-2 space-y-2">
      {actions.map((action, index) => (
        <li
          key={`${index}-${action.tool}`}
          className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900"
        >
          <p className="font-medium">
            <span className="mr-1.5 text-gray-500">{index + 1}.</span>
            {action.label}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-400">
            {action.reason}
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-blue-600 hover:underline dark:text-blue-400">
              Details
            </summary>
            <div className="mt-1 text-sm" aria-label={`${action.label} arguments`}>
              <ProposedCall call={action.call} />
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

/** `label: value` rows — mirrors an MCP preview card's own field list. */
function FieldRows({ rows }: { rows: FieldRow[] }): React.ReactNode {
  if (rows.length === 0) return null;
  return (
    <dl className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-1 break-words">
          <dt className="shrink-0 font-mono">{row.label}:</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One action's arguments, drawn for its tool family. */
function ProposedCall({ call }: { call: ProposedCallView }): React.ReactNode {
  if (call.kind === 'issue') {
    return (
      <>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          {call.summary && <p className="min-w-0 break-words font-medium">{call.summary}</p>}
          {call.subtitle && (
            <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              {call.subtitle}
            </span>
          )}
        </div>
        {call.description && (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-400">
            {call.description}
          </p>
        )}
        <FieldRows rows={call.rows} />
      </>
    );
  }
  if (call.kind === 'email') {
    return (
      <>
        <FieldRows rows={call.rows} />
        {call.subject && <p className="mt-2 break-words font-medium">{call.subject}</p>}
        {call.body && (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-400">
            {call.body}
          </p>
        )}
      </>
    );
  }
  return <FieldRows rows={call.rows} />;
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
      {asking ? 'Answer needed' : 'Go-ahead needed'}
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
  const wording = pauseOutcomeWording(kind, status, result);
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400">
      {wording}
    </p>
  );
}

/**
 * Similar prior discussion the pipeline found, already cleared through the
 * live ACL gate for the reporting user at enrichment time.
 */
function RelatedEvidence({ evidence }: { evidence: unknown }): React.ReactNode {
  const excerpts = relatedExcerpts(evidence);
  if (excerpts.length === 0) return null;

  return (
    <div className="my-2 rounded-md bg-gray-100 p-2 dark:bg-gray-900">
      <strong className="text-xs">Similar prior discussion</strong>
      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
        {excerpts.map((excerpt, index) => (
          <li key={index} className="break-words">
            {excerpt}
          </li>
        ))}
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
  const view = executionResultView(result, failed);
  if (view === null) return null;
  if (view.kind === 'failed') {
    return <p className="text-sm text-red-700 dark:text-red-300">Failed: {view.message}</p>;
  }
  return (
    <p className="text-sm">
      Created{' '}
      <ExternalLink
        href={view.url}
        className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {view.issueKey}
      </ExternalLink>
    </p>
  );
}
