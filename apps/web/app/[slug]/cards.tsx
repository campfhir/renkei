import React from 'react';
import Link from 'next/link';
import { friendlyToolName, parseFormNodes, type FormNode } from '@renkei/agents';
import { jiraIssueApprovalPreview } from '@/lib/mcp-tools/jira/approval-preview';
import { jiraIssueFieldRows } from '@/lib/mcp-tools/jira/fields';
import { Icon, ICONS } from '@/components/icons';
import CardActions from './card-actions';
import ApprovalActions from './approval-actions';
import ApprovalWidgetCard from './approval-widget-card';
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
export default async function ActionableCards({
  items,
  tenantId,
  subject,
  slug,
  showArchived = false,
}: {
  items: ActionableItemRow[];
  tenantId: string;
  /** Whose feed this is — the approval widget resolves ITS OWN Jira
   * grant by this subject, same as any decision on these cards already
   * requires the card's owner_subject to match it. */
  subject: string;
  /** The tenant's URL slug — approval cards link to their paused run. */
  slug: string;
  showArchived?: boolean;
}): Promise<React.ReactNode> {
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
    const widgetPreview =
      item.kind === 'approval'
        ? await widgetPreviewFor(item.suggested_action, item.status, tenantId, subject)
        : null;
    cards.push(
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
        <p className="my-2 whitespace-pre-wrap break-words text-sm">{item.summary}</p>

        <RelatedEvidence evidence={item.evidence} />

        {item.kind === 'approval' &&
          (widgetPreview ? (
            <ApprovalWidgetCard
              tenantId={tenantId}
              itemId={item.id}
              resourceUri={widgetPreview.resourceUri}
              structuredContent={widgetPreview.structuredContent}
            />
          ) : (
            <ProposedCall suggestedAction={item.suggested_action} result={item.result} />
          ))}

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
            <ApprovalActions
              tenantId={tenantId}
              itemId={item.id}
              hideApprove={widgetPreview !== null}
            />
          ) : item.kind === 'question' ? (
            <QuestionActions
              tenantId={tenantId}
              itemId={item.id}
              form={questionFormFrom(item.suggested_action)}
            />
          ) : (
            <CardActions tenantId={tenantId} itemId={item.id} dismissOnly={item.kind === 'info'} />
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
  }

  return <div className="space-y-4">{cards}</div>;
}

/** The form an ask_person call snapshotted onto its card. */
function questionFormFrom(suggestedAction: unknown): FormNode[] {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return [];
  const record: { form?: unknown } = { ...suggestedAction };
  return parseFormNodes(record.form);
}

/** Tools whose args are a Jira/JSM issue — same shape the issue-preview
 * MCP widget renders (jira/write.ts, jsm.ts), so the approval card can show
 * the same project/type header, summary, description and field rows
 * instead of a raw arg dump. */
const ISSUE_ARG_TOOLS = new Set([
  'jira_create_issue',
  'jira_create_issue_confirm',
  'jira_update_issue',
  'jira_update_issue_confirm',
  'jsm_create_request',
  'jsm_create_request_confirm',
]);

/** Tools whose args are an outgoing email — same fields the email-compose
 * MCP widget renders (outlook/index.ts). */
const EMAIL_ARG_TOOLS = new Set([
  'outlook_send_mail',
  'outlook_send_mail_confirm',
  'outlook_reply_message',
  'outlook_reply_confirm',
  'outlook_reply_all_message',
  'outlook_reply_all_confirm',
  'outlook_forward_message',
  'outlook_forward_confirm',
]);

/** The `{tool, args}` a `needsApproval` gate snapshotted onto a card, or
 * null for anything that does not even look like a proposed call. */
function proposedCallOf(
  suggestedAction: unknown
): { tool: string; args: Record<string, unknown> } | null {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return null;
  const record: { tool?: unknown; args?: unknown } = { ...suggestedAction };
  if (typeof record.tool !== 'string') return null;
  const args =
    typeof record.args === 'object' && record.args !== null && !Array.isArray(record.args)
      ? { ...record.args }
      : {};
  return { tool: record.tool, args };
}

/**
 * The real MCP Apps widget for this proposed call, when one exists — the
 * same issue-preview card the chat-side `jira_create_issue_preview`/
 * `jira_update_issue_preview` tools use, hosted outside chat
 * (ApprovalWidgetCard). Only while the card is still undecided: an
 * already-decided card keeps the plain historical rendering below rather
 * than a still-interactive-looking Confirm button (decideApproval's own
 * status check makes a stray click harmless, but showing one at all on a
 * resolved card is just confusing).
 *
 * Awaits a live, best-effort Jira field-schema fetch (jiraIssueApprovalPreview
 * → approval-field-schema.ts) so the card's fields render as typed controls
 * — this is the one place a page render in this app calls out to a
 * provider; a failed or slow fetch degrades to plain-text fields rather
 * than failing the render.
 */
async function widgetPreviewFor(
  suggestedAction: unknown,
  status: string,
  tenantId: string,
  subject: string
): Promise<{ resourceUri: string; structuredContent: Record<string, unknown> } | null> {
  if (status !== 'suggested') return null;
  const call = proposedCallOf(suggestedAction);
  if (!call) return null;
  return jiraIssueApprovalPreview(call.tool, call.args, tenantId, subject);
}

/** A decided card's own edit, if it has one (ApprovalWidgetCard's Confirm,
 * via `decideApproval`'s `argsOverride`) — already stripped server-side of
 * anything the call's identity depends on (approvals.ts's
 * `APPROVAL_IDENTITY_KEYS`), so trusted here as-is. */
function argsOverrideOf(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return {};
  const record: { argsOverride?: unknown } = { ...result };
  if (typeof record.argsOverride !== 'object' || record.argsOverride === null) return {};
  return { ...record.argsOverride };
}

/**
 * The proposed call a `needsApproval` gate's card shows — never an
 * authored message, since there is nothing to author: the point of the
 * flag is "gate whatever this step is about to do." Shown only while the
 * card is still undecided; a decided one's outcome line below covers it.
 *
 * Rendered the way the chat-side MCP Apps preview cards render the same
 * calls (issue-preview.ts, email-compose.ts) for the tool families common
 * enough to be worth it — everything else falls back to a plain arg list.
 * The Jira-issue case actually hosts that same widget bundle instead
 * (ApprovalWidgetCard, above this in the parent) while the card is
 * decidable; this is what a decided one keeps showing, and what any other
 * Jira-issue-shaped call falls back to before this file grows a widget for
 * every family (email included, for now).
 *
 * `result` is only ever read for its `argsOverride` — a decided card whose
 * widget edited the summary/description should keep showing what was
 * actually approved, not the pre-edit snapshot everything else here still
 * reads from `suggested_action`.
 */
function ProposedCall({
  suggestedAction,
  result,
}: {
  suggestedAction: unknown;
  result?: unknown;
}): React.ReactNode {
  const call = proposedCallOf(suggestedAction);
  if (!call) return null;
  const toolLabel = friendlyToolName(call.tool, null);
  const args = { ...call.args, ...argsOverrideOf(result) };

  if (ISSUE_ARG_TOOLS.has(call.tool)) {
    return <IssueProposedCall toolLabel={toolLabel} args={args} />;
  }
  if (EMAIL_ARG_TOOLS.has(call.tool)) {
    return <EmailProposedCall toolLabel={toolLabel} args={args} />;
  }
  return <GenericProposedCall toolLabel={toolLabel} args={args} />;
}

/** Shared shell every "Wants to call …" card variant renders inside. */
function ProposedCallShell({
  toolLabel,
  children,
}: {
  toolLabel: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="my-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-900">
      <strong>Wants to call {toolLabel}</strong>
      {children}
    </div>
  );
}

/** `label: value` rows, the shape both the issue and email cards below
 * reduce their args to — mirrors an MCP preview card's own field list. */
function FieldRows({ rows }: { rows: { label: string; value: string }[] }): React.ReactNode {
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

/** A Jira/JSM issue create-or-update call — project/type header (or the
 * issue key, on an update), summary, description, and everything else
 * jiraIssueFieldRows already knows how to lay out. No live Jira fetch: this
 * is the call as written, the same way the preview card shows it before a
 * person confirms. */
function IssueProposedCall({
  toolLabel,
  args,
}: {
  toolLabel: string;
  args: Record<string, unknown>;
}): React.ReactNode {
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const projectKey = str(args.projectKey);
  const issueType = str(args.issueType);
  const issueKey = str(args.issueKey);
  const subtitle = [projectKey, issueType].filter(Boolean).join(' · ') || issueKey;
  const summary = str(args.summary);
  const description = str(args.description);
  return (
    <ProposedCallShell toolLabel={toolLabel}>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        {summary && <p className="min-w-0 break-words font-medium">{summary}</p>}
        {subtitle && (
          <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {subtitle}
          </span>
        )}
      </div>
      {description && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-400">
          {description}
        </p>
      )}
      <FieldRows rows={jiraIssueFieldRows(args)} />
    </ProposedCallShell>
  );
}

/** An outgoing email — recipients, subject, and body, the same fields the
 * email-compose card shows. Reply/reply-all/forward auto-populate their
 * primary recipient(s) server-side (Graph fills them from the message
 * being replied to), so `additionalTo` stands in for `to` when that's all
 * the call carries. */
function EmailProposedCall({
  toolLabel,
  args,
}: {
  toolLabel: string;
  args: Record<string, unknown>;
}): React.ReactNode {
  const addresses = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const to = addresses(args.to);
  const additionalTo = addresses(args.additionalTo);
  const cc = addresses(args.cc);
  const bcc = addresses(args.bcc);
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const body =
    typeof args.body === 'string'
      ? args.body
      : typeof args.comment === 'string'
        ? args.comment
        : '';

  const rows: { label: string; value: string }[] = [];
  if (to.length > 0) rows.push({ label: 'To', value: to.join(', ') });
  else if (additionalTo.length > 0) {
    rows.push({ label: 'Also to', value: `(auto-populated) ${additionalTo.join(', ')}` });
  }
  if (cc.length > 0) rows.push({ label: 'Cc', value: cc.join(', ') });
  if (bcc.length > 0) rows.push({ label: 'Bcc', value: bcc.join(', ') });

  return (
    <ProposedCallShell toolLabel={toolLabel}>
      <FieldRows rows={rows} />
      {subject && <p className="mt-2 break-words font-medium">{subject}</p>}
      {body && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-400">
          {body}
        </p>
      )}
    </ProposedCallShell>
  );
}

/** The fallback for any tool without a dedicated card above — every arg,
 * `key: value`. `String()` on an object or array gives "[object
 * Object]"/comma-joined junk, so anything non-primitive is JSON-stringified
 * instead. */
function GenericProposedCall({
  toolLabel,
  args,
}: {
  toolLabel: string;
  args: Record<string, unknown>;
}): React.ReactNode {
  const formatValue = (value: unknown): string =>
    value === null || typeof value !== 'object' ? String(value) : JSON.stringify(value);
  return (
    <ProposedCallShell toolLabel={toolLabel}>
      <FieldRows
        rows={Object.entries(args).map(([key, value]) => ({
          label: key,
          value: formatValue(value),
        }))}
      />
    </ProposedCallShell>
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
