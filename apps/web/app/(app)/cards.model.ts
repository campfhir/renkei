/**
 * What the home feed's cards (cards.tsx) say: a proposed batch's actions
 * and each action's arguments, laid out for its tool family — a Jira/JSM
 * issue as a project/type header, summary, description and field rows; an
 * Outlook mail as To/Cc/Bcc, subject and body; anything else as a plain
 * `key: value` list where no value ever reads "[object Object]" — plus the
 * line a decided approval or question leaves, and an executed card's result.
 *
 * No state: the feed is server-rendered, so these are pure functions the
 * component draws from, tested in cards.model.test.ts.
 */

import {
  friendlyToolName,
  parseFormNodes,
  parseStoredActions,
  type FormNode,
} from '@renkei/agents';
import { isRecord, isString } from '@renkei/guards';
import { jiraIssueFieldRows } from '@/lib/mcp-tools/jira/fields';

export interface FieldRow {
  label: string;
  value: string;
}

/** One staged action, as its card lists it. */
export interface ProposedAction {
  tool: string;
  /** "Create issue", "Send mail" — what it would do, in words. */
  label: string;
  reason: string;
  call: ProposedCallView;
}

/** One action's arguments, laid out for its tool family. */
export type ProposedCallView =
  | {
      kind: 'issue';
      /** "CIO · Project" — or the issue key, on an update. '' when neither. */
      subtitle: string;
      summary: string;
      description: string;
      rows: FieldRow[];
    }
  | { kind: 'email'; rows: FieldRow[]; subject: string; body: string }
  | { kind: 'fields'; rows: FieldRow[] };

/** Tools whose args are a Jira/JSM issue — the shape the issue-preview card renders. */
const ISSUE_ARG_TOOLS = new Set([
  'jira_create_issue',
  'jira_create_issue_confirm',
  'jira_update_issue',
  'jira_update_issue_confirm',
  'jsm_create_request',
  'jsm_create_request_confirm',
]);

/** Tools whose args are an outgoing email — the fields the email-compose card renders. */
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

const text = (value: unknown): string => (isString(value) ? value : '');

const addresses = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(isString) : [];

/**
 * A value as one line of text: a string or number as itself, anything
 * structured as JSON — `String()` on an object gives "[object Object]".
 */
export function formatArgValue(value: unknown): string {
  return value === null || typeof value !== 'object' ? String(value) : JSON.stringify(value);
}

/** A Jira/JSM create-or-update call, as written — no live Jira fetch. */
function issueCall(args: Record<string, unknown>): ProposedCallView {
  const subtitle =
    [text(args.projectKey), text(args.issueType)].filter(Boolean).join(' · ') ||
    text(args.issueKey);
  return {
    kind: 'issue',
    subtitle,
    summary: text(args.summary),
    description: text(args.description),
    rows: jiraIssueFieldRows(args),
  };
}

/**
 * An outgoing email. Reply/reply-all/forward fill their primary
 * recipients server-side from the message replied to, so `additionalTo`
 * stands in for `to` when that's all the call carries.
 */
function emailCall(args: Record<string, unknown>): ProposedCallView {
  const to = addresses(args.to);
  const additionalTo = addresses(args.additionalTo);
  const cc = addresses(args.cc);
  const bcc = addresses(args.bcc);
  const rows: FieldRow[] = [];
  if (to.length > 0) rows.push({ label: 'To', value: to.join(', ') });
  else if (additionalTo.length > 0) {
    rows.push({ label: 'Also to', value: `(auto-populated) ${additionalTo.join(', ')}` });
  }
  if (cc.length > 0) rows.push({ label: 'Cc', value: cc.join(', ') });
  if (bcc.length > 0) rows.push({ label: 'Bcc', value: bcc.join(', ') });
  return {
    kind: 'email',
    rows,
    subject: text(args.subject),
    body: isString(args.body) ? args.body : text(args.comment),
  };
}

export function proposedCallView(tool: string, args: Record<string, unknown>): ProposedCallView {
  if (ISSUE_ARG_TOOLS.has(tool)) return issueCall(args);
  if (EMAIL_ARG_TOOLS.has(tool)) return emailCall(args);
  return {
    kind: 'fields',
    rows: Object.entries(args).map(([label, value]) => ({ label, value: formatArgValue(value) })),
  };
}

/** The batch an approval card proposes, in the order accepting would run it. */
export function proposedActions(suggestedAction: unknown): ProposedAction[] {
  const record = isRecord(suggestedAction) ? suggestedAction : {};
  return parseStoredActions(record.actions).map((action) => ({
    tool: action.tool,
    label: friendlyToolName(action.tool, null),
    reason: action.reason,
    call: proposedCallView(action.tool, action.args),
  }));
}

/** The form an ask_person call snapshotted onto its card. */
export function questionFormFrom(suggestedAction: unknown): FormNode[] {
  return isRecord(suggestedAction) ? parseFormNodes(suggestedAction.form) : [];
}

/** What happened to a decided approval or question card — the feed's audit line. */
export function pauseOutcomeWording(
  kind: 'approval' | 'question',
  status: string,
  result: unknown
): string {
  const record = isRecord(result) ? result : {};
  const ended = record.reason === 'run-ended' || record.reason === 'agent-disabled';
  const comment = isString(record.comment) ? record.comment : '';
  if (kind === 'question') {
    if (status === 'answered') return 'You answered — the run continued.';
    return ended
      ? 'The run ended before anyone answered.'
      : 'Nobody answered in time — the run treated it as unanswered.';
  }
  if (status === 'approved') {
    return comment
      ? `You accepted: ${comment}`
      : 'You accepted — the actions were carried out and the run continued.';
  }
  if (status === 'declined') return comment ? `You declined: ${comment}` : 'You declined.';
  return ended
    ? 'The run ended before anyone decided.'
    : 'Nobody decided in time — none of the actions were made.';
}

/** An executed or failed card's result line. */
export type ExecutionResultView =
  { kind: 'failed'; message: string } | { kind: 'created'; issueKey: string; url: string } | null;

export function executionResultView(result: unknown, failed: boolean): ExecutionResultView {
  if (!isRecord(result)) return null;
  if (failed) {
    return {
      kind: 'failed',
      message: result.error == null ? 'unknown error' : formatArgValue(result.error),
    };
  }
  if (isString(result.url) && isString(result.issueKey)) {
    return { kind: 'created', issueKey: result.issueKey, url: result.url };
  }
  return null;
}

/** The "Similar prior discussion" excerpts the pipeline attached to a card. */
export function relatedExcerpts(evidence: unknown): string[] {
  if (!isRecord(evidence) || !Array.isArray(evidence.related)) return [];
  return evidence.related.flatMap((entry: unknown) =>
    isRecord(entry) ? [entry.excerpt == null ? '' : formatArgValue(entry.excerpt)] : []
  );
}
