/**
 * What an act tool DID — the success-side twin of `outcomeError`.
 *
 * `outcomeError` lets a handler name the condition it failed on. This lets
 * one name the thing it produced: "Created a Jira issue", and the key of
 * the issue, and a link to it. That is the difference between a finished
 * run reading "7 tool calls across 3 tools" and reading "Created PROJ-1234
 * and emailed the reporter".
 *
 * ## The layering, mirroring resolveOutcomes exactly
 *
 * 1. A RECEIPT the handler put in `_meta` — the only source that can carry
 *    an actual identifier, because only the handler saw the response.
 * 2. A CURATED descriptor, keyed by tool name — the category and the
 *    wording, for a tool that has not been taught to emit a receipt yet.
 * 3. GENERIC — connector from `connectorKeyForTool`, category 'other', and
 *    the tool's friendly name as the sentence.
 *
 * The point of layer 3 is that coverage never depends on curation. Every
 * act tool produces a notification the day the stamp lands; curating one
 * upgrades its wording and gives it a link. What degrades is prose, never
 * whether the thing was recorded.
 *
 * ## Why there is no regex over the result text
 *
 * It would be the fast way to get an issue key out of a hundred tools at
 * once, and it is the wrong one. Provider prose changes for reasons that
 * have nothing to do with us, and a silently WRONG identifier in a
 * notification — a link to somebody else's ticket — is worse than no
 * identifier at all. A receipt or nothing.
 */

import { connectorKeyForTool } from './tool-connector';

/**
 * What an act did, coarsely.
 *
 * This is NOT what a person is offered as a switch — an early version made
 * it a connector × category grid and it asked, in a table cell, what
 * "Scheduled" means for Jira. Nothing does. Acts do not distribute evenly
 * across categories, and a grid that pretends they do spends most of its
 * cells on combinations that can never happen.
 *
 * The two jobs a category is genuinely good at, and keeps: it ORDERS a
 * connector's acts in the preferences list, and it supplies the DEFAULT for
 * an act nobody has chosen for — including the one category a person really
 * does have a blanket opinion about, 'other', the uncurated remainder.
 *
 * Defined HERE, with the acts, and imported by @renkei/user-prefs where the
 * opinions are stored. Two copies would be a category with no switch, or a
 * switch for a category nothing ever emits.
 */
export type ActCategory = 'created' | 'sent' | 'updated' | 'deleted' | 'scheduled' | 'other';

/** Every category, in the order the preferences page shows them. */
export const ACT_CATEGORIES: ActCategory[] = [
  'created',
  'sent',
  'updated',
  'deleted',
  'scheduled',
  'other',
];

/** The `_meta` key a handler puts its receipt under. */
export const ACT_META_KEY = 'renkei/act';

/** What a handler knows about the thing it just produced. */
export interface ActReceipt {
  /** The identifier as a person says it — 'PROJ-1234', not a uuid. */
  id?: string;
  /**
   * An absolute link to the thing, for the notification to point at — https
   * for every provider's own web link, or one of the handful of other
   * schemes this codebase itself builds a receipt out of (WebEx's
   * `webexteams://` deep link; see `ALLOWED_URL_SCHEMES` below).
   */
  url?: string;
  /** Overrides the descriptor's entity, for a tool that acts on several. */
  entity?: string;
  /**
   * Overrides the descriptor's sentence, for the handful of tools where one
   * name covers several genuinely different acts.
   *
   * `outlook_respond_event` is the case that earns it: accepting and
   * declining a meeting are opposite things to be told about, and only the
   * handler knows which one happened. A descriptor could only ever say
   * "answered an invitation", which is the least useful half of the news.
   *
   * Handlers are our own code, so this is not model output — but a handler
   * could build one out of an argument that IS, so `receiptOf` caps the
   * length and strips line breaks rather than trusting the caller.
   */
  label?: string;
}

/** A headline has to fit on a toast; past this it is not a headline. */
const MAX_LABEL = 120;

/**
 * How a connector declares what one of its act tools did.
 *
 * The platform never switches on a tool name; adding a connector's acts is
 * entries in the record below. That is the same shape the trigger filters
 * use, and for the same reason: a per-connector feature should be data.
 */
export interface ActOutcomeDescriptor {
  category: ActCategory;
  /**
   * Singular lower-case noun: 'issue', 'email', 'page', 'meeting'.
   *
   * There is deliberately NO connector field. It would have to equal
   * `connectorKeyForTool(name)` for a notification to be grouped under the
   * right logo and the right preference switch, so declaring it separately
   * only creates a way to disagree with the catalog — silently. The first
   * draft of this file got two of them wrong ('confluence' for
   * 'atlassian-confluence', 'card' for 'cards'), which is the argument.
   */
  entity: string;
  /**
   * Past tense, and WITHOUT an identifier. The renderer appends one when a
   * receipt carried it, so a tool that yields none still reads correctly.
   *
   * This one stands ALONE — in a toast, in a feed, next to notifications
   * from six other connectors — so it names the connector: "Created a Jira
   * issue", not "Created an issue".
   */
  label: string;
  /**
   * The same act as it reads in the preferences list, where it sits UNDER a
   * Jira heading among a dozen other Jira rows. "Created a Jira issue"
   * there is a stutter; "Created an issue" is the sentence.
   *
   * Two fields rather than one derived from the other, because the
   * derivation would be a regex over English and would get
   * `jsm_create_request` ("Raised a service request", under Jira) wrong.
   */
  short: string;
}

/** What a caller gets back: enough to render a line and link it. */
export interface ResolvedAct {
  category: ActCategory;
  connector: string | null;
  entity: string | null;
  /** 'Created a Jira issue PROJ-1234' */
  headline: string;
  id: string | null;
  url: string | null;
  /** False when this came from the generic path. */
  curated: boolean;
}

/**
 * The success helper handlers adopt, shaped like `outcomeError`. A handler
 * that uses it turns its notification from "ran jira_create_issue" into
 * "Created a Jira issue PROJ-1234" with a link.
 */
export function actResult(
  text: string,
  receipt: ActReceipt
): {
  content: { type: 'text'; text: string }[];
  _meta: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text }],
    _meta: actMeta(receipt),
  };
}

/**
 * Just the `_meta` fragment, for a handler that already returns one.
 *
 * Plenty do — the Jira and JSM tools return a widget URI via
 * `previewToolMeta` — so `actResult` would clobber it. Those handlers
 * spread this instead: `_meta: { ...previewToolMeta(URI), ...actMeta({id}) }`.
 */
export function actMeta(receipt: ActReceipt): Record<string, unknown> {
  return { [ACT_META_KEY]: { ...receipt } };
}

/**
 * A short label needs the connector name stripped, and a standalone one
 * needs it present — for the two document namespaces that is the ONLY
 * difference between sixteen otherwise identical entries, so they are
 * generated rather than typed out twice.
 *
 * `graph/documents.ts` registers this set once against a prefix, which is
 * exactly why it is a family here too: a tool added there appears under
 * both connectors, and so should its wording.
 */
function documentActs(prefix: string, service: string): Record<string, ActOutcomeDescriptor> {
  const family: [string, ActCategory, string, string][] = [
    ['create_folder', 'created', 'folder', 'Created a folder'],
    ['copy_document', 'created', 'document', 'Copied a document'],
    ['share_document', 'sent', 'document', 'Shared a document'],
    ['rename_document', 'updated', 'document', 'Renamed a document'],
    ['move_document', 'updated', 'document', 'Moved a document'],
    ['add_user_to_document', 'updated', 'document', 'Gave someone access to a document'],
    ['remove_user_from_document', 'updated', 'document', 'Took away access to a document'],
    ['delete_document', 'deleted', 'document', 'Deleted a document'],
  ];
  const out: Record<string, ActOutcomeDescriptor> = {};
  for (const [suffix, category, entity, short] of family) {
    // "Created a folder" → "Created a SharePoint folder": the article is
    // already in the short form, so the service name slots after it.
    const label = short.replace(/^(\w+) an? /, `$1 a ${service} `);
    out[`${prefix}_${suffix}`] = { category, entity, label, short };
  }
  return out;
}

/**
 * Every act Renkei has wording for, keyed by tool name.
 *
 * ## What belongs here, and what does not
 *
 * An entry earns its place when a person would recognise the act as
 * something that HAPPENED to their systems — a ticket filed, a page
 * edited, an invitation answered. Plumbing does not qualify: the
 * `*_request_*_upload` tools hand back a URL and change nothing until
 * bytes follow, and the `*_preview` / `*_confirm` pairs are the app's own
 * card buttons, which an agent run never calls. Those fall through to the
 * generic path and land under "anything else", switched off by default.
 *
 * ## Why this is a flat record and not per-connector files
 *
 * Because `resolveAct` looks acts up by tool name, and the preferences
 * page groups them by `connectorKeyForTool`. One map serves both, and the
 * grouping can never disagree with the catalog — which is the same reason
 * `ActOutcomeDescriptor` has no connector field of its own.
 */
export const ACT_OUTCOMES: Record<string, ActOutcomeDescriptor> = {
  // ---- Jira -------------------------------------------------------------
  jira_create_issue: {
    category: 'created',
    entity: 'issue',
    label: 'Created a Jira issue',
    short: 'Created an issue',
  },
  jira_update_issue: {
    category: 'updated',
    entity: 'issue',
    label: 'Updated a Jira issue',
    short: 'Edited an issue',
  },
  jira_transition_issue: {
    category: 'updated',
    entity: 'issue',
    label: 'Moved a Jira issue',
    short: 'Moved an issue through its workflow',
  },
  jira_bulk_update_issues: {
    category: 'updated',
    entity: 'issues',
    label: 'Updated several Jira issues',
    short: 'Edited several issues at once',
  },
  jira_bulk_transition_issues: {
    category: 'updated',
    entity: 'issues',
    label: 'Moved several Jira issues',
    short: 'Moved several issues at once',
  },
  jira_add_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a Jira issue',
    short: 'Commented on an issue',
  },
  jira_delete_comment: {
    category: 'deleted',
    entity: 'comment',
    label: 'Deleted a Jira comment',
    short: 'Deleted a comment',
  },
  jira_add_attachment: {
    category: 'created',
    entity: 'attachment',
    label: 'Attached a file to a Jira issue',
    short: 'Attached a file to an issue',
  },
  jira_log_work: {
    category: 'created',
    entity: 'worklog',
    label: 'Logged work on a Jira issue',
    short: 'Logged work against an issue',
  },
  jira_create_worklog: {
    category: 'created',
    entity: 'worklog',
    label: 'Logged work on a Jira issue',
    short: 'Added a worklog entry',
  },
  jira_delete_worklog: {
    category: 'deleted',
    entity: 'worklog',
    label: 'Deleted a Jira worklog entry',
    short: 'Deleted a worklog entry',
  },
  jira_create_issue_link: {
    category: 'created',
    entity: 'link',
    label: 'Linked two Jira issues',
    short: 'Linked two issues',
  },
  jira_delete_issue_link: {
    category: 'deleted',
    entity: 'link',
    label: 'Unlinked two Jira issues',
    short: 'Removed a link between issues',
  },
  jira_create_remote_link: {
    category: 'created',
    entity: 'link',
    label: 'Added a link to a Jira issue',
    short: 'Added a web link to an issue',
  },
  jira_create_sprint: {
    category: 'created',
    entity: 'sprint',
    label: 'Created a Jira sprint',
    short: 'Created a sprint',
  },
  jira_complete_sprint: {
    category: 'updated',
    entity: 'sprint',
    label: 'Completed a Jira sprint',
    short: 'Completed a sprint',
  },
  jira_move_issue_to_sprint: {
    category: 'updated',
    entity: 'issue',
    label: 'Moved a Jira issue into a sprint',
    short: 'Moved an issue into a sprint',
  },
  jira_remove_issue_from_sprint: {
    category: 'updated',
    entity: 'issue',
    label: 'Moved a Jira issue to the backlog',
    short: 'Moved an issue to the backlog',
  },
  jira_bulk_move_sprint_issues: {
    category: 'updated',
    entity: 'issues',
    label: 'Moved several Jira issues into a sprint',
    short: 'Moved several issues into a sprint',
  },
  jira_create_version: {
    category: 'created',
    entity: 'version',
    label: 'Created a Jira version',
    short: 'Created a project version',
  },
  jira_create_component: {
    category: 'created',
    entity: 'component',
    label: 'Created a Jira component',
    short: 'Created a project component',
  },
  jira_delete_component: {
    category: 'deleted',
    entity: 'component',
    label: 'Deleted a Jira component',
    short: 'Deleted a project component',
  },
  jira_create_filter: {
    category: 'created',
    entity: 'filter',
    label: 'Created a Jira filter',
    short: 'Created a filter',
  },
  jira_delete_filter: {
    category: 'deleted',
    entity: 'filter',
    label: 'Deleted a Jira filter',
    short: 'Deleted a filter',
  },
  jira_delete_issue: {
    category: 'deleted',
    entity: 'issue',
    label: 'Deleted a Jira issue',
    short: 'Deleted an issue',
  },

  // ---- Jira Service Management -----------------------------------------
  // Same capability key as Jira ('jira'), so these appear in the same
  // preferences group. Their wording says "service request" precisely so
  // the two are still tellable apart in one list.
  jsm_create_request: {
    category: 'created',
    entity: 'request',
    label: 'Raised a service request',
    short: 'Raised a service request',
  },
  jsm_transition_request: {
    category: 'updated',
    entity: 'request',
    label: 'Moved a service request',
    short: 'Moved a service request',
  },
  jsm_add_request_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a service request',
    short: 'Commented on a service request',
  },
  jsm_add_request_participant: {
    category: 'updated',
    entity: 'request',
    label: 'Added someone to a service request',
    short: 'Added a participant to a request',
  },
  jsm_remove_request_participant: {
    category: 'updated',
    entity: 'request',
    label: 'Removed someone from a service request',
    short: 'Removed a participant from a request',
  },
  jsm_create_customer: {
    category: 'created',
    entity: 'customer',
    label: 'Created a service desk customer',
    short: 'Created a customer',
  },
  jsm_invite_customers_to_servicedesk: {
    category: 'sent',
    entity: 'invitation',
    label: 'Invited someone to a service desk',
    short: 'Invited someone to a service desk',
  },
  jsm_add_customer_to_servicedesk: {
    category: 'updated',
    entity: 'customer',
    label: 'Added a customer to a service desk',
    short: 'Added a customer to a service desk',
  },
  jsm_remove_customer_from_servicedesk: {
    category: 'deleted',
    entity: 'customer',
    label: 'Removed a customer from a service desk',
    short: 'Removed a customer from a service desk',
  },
  jsm_ops_acknowledge_alert: {
    category: 'updated',
    entity: 'alert',
    label: 'Acknowledged an on-call alert',
    short: 'Acknowledged an on-call alert',
  },
  jsm_ops_close_alert: {
    category: 'updated',
    entity: 'alert',
    label: 'Closed an on-call alert',
    short: 'Closed an on-call alert',
  },
  jsm_ops_create_override: {
    category: 'created',
    entity: 'override',
    label: 'Created an on-call override',
    short: 'Created an on-call override',
  },
  jsm_ops_delete_override: {
    category: 'deleted',
    entity: 'override',
    label: 'Deleted an on-call override',
    short: 'Deleted an on-call override',
  },
  jsm_ops_update_rotation: {
    category: 'updated',
    entity: 'rotation',
    label: 'Changed an on-call rotation',
    short: 'Changed an on-call rotation',
  },

  // ---- Outlook / Microsoft 365 -----------------------------------------
  outlook_send_mail: {
    category: 'sent',
    entity: 'email',
    label: 'Sent an email',
    short: 'Sent an email',
  },
  outlook_reply_message: {
    category: 'sent',
    entity: 'email',
    label: 'Replied to an email',
    short: 'Replied to an email',
  },
  outlook_reply_all_message: {
    category: 'sent',
    entity: 'email',
    label: 'Replied to all on an email',
    short: 'Replied to all on an email',
  },
  outlook_forward_message: {
    category: 'sent',
    entity: 'email',
    label: 'Forwarded an email',
    short: 'Forwarded an email',
  },
  outlook_start_bulk_mail_job: {
    category: 'sent',
    entity: 'emails',
    label: 'Started sending a batch of email',
    short: 'Started a batch of email',
  },
  // One tool, opposite acts. The handler overrides the label from the
  // response it chose, so a notification says "Declined" rather than the
  // useless middle ground a descriptor alone could offer.
  outlook_respond_event: {
    category: 'sent',
    entity: 'invitation',
    label: 'Answered a meeting invitation',
    short: 'Accepted or declined an invitation',
  },
  outlook_create_event: {
    category: 'scheduled',
    entity: 'meeting',
    label: 'Scheduled a meeting',
    short: 'Scheduled a meeting',
  },
  outlook_move_message: {
    category: 'updated',
    entity: 'email',
    label: 'Filed an email',
    short: 'Moved an email to another folder',
  },
  outlook_flag_message: {
    category: 'updated',
    entity: 'email',
    label: 'Flagged an email',
    short: 'Flagged or unflagged an email',
  },
  outlook_categorize_message: {
    category: 'updated',
    entity: 'email',
    label: 'Categorised an email',
    short: 'Categorised an email',
  },
  outlook_mark_message: {
    category: 'updated',
    entity: 'email',
    label: 'Marked an email read',
    short: 'Marked an email read or unread',
  },
  outlook_create_mail_folder: {
    category: 'created',
    entity: 'folder',
    label: 'Created a mail folder',
    short: 'Created a mail folder',
  },
  outlook_rename_mail_folder: {
    category: 'updated',
    entity: 'folder',
    label: 'Renamed a mail folder',
    short: 'Renamed a mail folder',
  },
  outlook_delete_mail_folder: {
    category: 'deleted',
    entity: 'folder',
    label: 'Deleted a mail folder',
    short: 'Deleted a mail folder',
  },

  // ---- Confluence -------------------------------------------------------
  confluence_create_page: {
    category: 'created',
    entity: 'page',
    label: 'Created a Confluence page',
    short: 'Created a page',
  },
  confluence_update_page: {
    category: 'updated',
    entity: 'page',
    label: 'Updated a Confluence page',
    short: 'Edited a page',
  },
  confluence_update_page_title: {
    category: 'updated',
    entity: 'page',
    label: 'Renamed a Confluence page',
    short: 'Renamed a page',
  },
  confluence_move_page: {
    category: 'updated',
    entity: 'page',
    label: 'Moved a Confluence page',
    short: 'Moved a page',
  },
  confluence_set_page_status: {
    category: 'updated',
    entity: 'page',
    label: 'Changed a Confluence page’s status',
    short: 'Changed a page’s status',
  },
  confluence_set_page_property: {
    category: 'updated',
    entity: 'page',
    label: 'Changed a Confluence page’s metadata',
    short: 'Changed a page’s metadata',
  },
  confluence_delete_page: {
    category: 'deleted',
    entity: 'page',
    label: 'Deleted a Confluence page',
    short: 'Deleted a page',
  },
  confluence_add_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a Confluence page',
    short: 'Commented on a page',
  },
  confluence_update_comment: {
    category: 'updated',
    entity: 'comment',
    label: 'Edited a Confluence comment',
    short: 'Edited a comment',
  },
  confluence_delete_comment: {
    category: 'deleted',
    entity: 'comment',
    label: 'Deleted a Confluence comment',
    short: 'Deleted a comment',
  },
  confluence_create_blogpost: {
    category: 'created',
    entity: 'blog post',
    label: 'Created a Confluence blog post',
    short: 'Created a blog post',
  },
  confluence_update_blogpost: {
    category: 'updated',
    entity: 'blog post',
    label: 'Updated a Confluence blog post',
    short: 'Edited a blog post',
  },
  confluence_delete_blogpost: {
    category: 'deleted',
    entity: 'blog post',
    label: 'Deleted a Confluence blog post',
    short: 'Deleted a blog post',
  },
  confluence_add_label: {
    category: 'updated',
    entity: 'label',
    label: 'Labelled something in Confluence',
    short: 'Added a label',
  },
  confluence_remove_label: {
    category: 'updated',
    entity: 'label',
    label: 'Removed a Confluence label',
    short: 'Removed a label',
  },
  confluence_update_task_status: {
    category: 'updated',
    entity: 'task',
    label: 'Changed a Confluence task’s status',
    short: 'Ticked a task off, or back on',
  },
  confluence_create_whiteboard: {
    category: 'created',
    entity: 'whiteboard',
    label: 'Created a Confluence whiteboard',
    short: 'Created a whiteboard',
  },
  confluence_delete_whiteboard: {
    category: 'deleted',
    entity: 'whiteboard',
    label: 'Deleted a Confluence whiteboard',
    short: 'Deleted a whiteboard',
  },
  confluence_create_database: {
    category: 'created',
    entity: 'database',
    label: 'Created a Confluence database',
    short: 'Created a database',
  },
  confluence_delete_database: {
    category: 'deleted',
    entity: 'database',
    label: 'Deleted a Confluence database',
    short: 'Deleted a database',
  },
  confluence_delete_attachment: {
    category: 'deleted',
    entity: 'attachment',
    label: 'Deleted a Confluence attachment',
    short: 'Deleted an attachment',
  },

  // ---- Bitbucket ---------------------------------------------------------
  bitbucket_create_pull_request: {
    category: 'created',
    entity: 'pull request',
    label: 'Opened a Bitbucket pull request',
    short: 'Opened a pull request',
  },
  bitbucket_create_pull_request_confirm: {
    category: 'created',
    entity: 'pull request',
    label: 'Opened a Bitbucket pull request',
    short: 'Opened a pull request',
  },
  bitbucket_update_pull_request: {
    category: 'updated',
    entity: 'pull request',
    label: 'Updated a Bitbucket pull request',
    short: 'Edited a pull request',
  },
  bitbucket_approve_pull_request: {
    category: 'updated',
    entity: 'pull request',
    label: 'Approved a Bitbucket pull request',
    short: 'Approved a pull request',
  },
  bitbucket_request_pr_changes: {
    category: 'updated',
    entity: 'pull request',
    label: 'Requested changes on a Bitbucket pull request',
    short: 'Requested changes',
  },
  bitbucket_merge_pull_request: {
    category: 'updated',
    entity: 'pull request',
    label: 'Merged a Bitbucket pull request',
    short: 'Merged a pull request',
  },
  bitbucket_merge_pull_request_confirm: {
    category: 'updated',
    entity: 'pull request',
    label: 'Merged a Bitbucket pull request',
    short: 'Merged a pull request',
  },
  bitbucket_decline_pull_request: {
    category: 'updated',
    entity: 'pull request',
    label: 'Declined a Bitbucket pull request',
    short: 'Declined a pull request',
  },
  bitbucket_add_pr_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a Bitbucket pull request',
    short: 'Commented on a pull request',
  },
  bitbucket_add_pr_task: {
    category: 'created',
    entity: 'task',
    label: 'Added a task to a Bitbucket pull request',
    short: 'Added a pull request task',
  },
  bitbucket_create_project: {
    category: 'created',
    entity: 'project',
    label: 'Created a Bitbucket project',
    short: 'Created a project',
  },
  bitbucket_update_project: {
    category: 'updated',
    entity: 'project',
    label: 'Updated a Bitbucket project',
    short: 'Edited a project',
  },
  bitbucket_delete_project: {
    category: 'deleted',
    entity: 'project',
    label: 'Deleted a Bitbucket project',
    short: 'Deleted a project',
  },
  bitbucket_grant_repository_permission: {
    category: 'updated',
    entity: 'repository access',
    label: 'Granted access to a Bitbucket repository',
    short: 'Granted repository access',
  },
  bitbucket_revoke_repository_permission: {
    category: 'updated',
    entity: 'repository access',
    label: 'Revoked access to a Bitbucket repository',
    short: 'Revoked repository access',
  },
  bitbucket_create_branch: {
    category: 'created',
    entity: 'branch',
    label: 'Created a Bitbucket branch',
    short: 'Created a branch',
  },
  bitbucket_delete_branch: {
    category: 'deleted',
    entity: 'branch',
    label: 'Deleted a Bitbucket branch',
    short: 'Deleted a branch',
  },
  bitbucket_commit_file: {
    category: 'created',
    entity: 'commit',
    label: 'Committed a file change to Bitbucket',
    short: 'Committed a file',
  },
  bitbucket_trigger_pipeline: {
    category: 'other',
    entity: 'pipeline run',
    label: 'Started a Bitbucket pipeline',
    short: 'Started a pipeline',
  },
  bitbucket_trigger_pipeline_confirm: {
    category: 'other',
    entity: 'pipeline run',
    label: 'Started a Bitbucket pipeline',
    short: 'Started a pipeline',
  },
  bitbucket_stop_pipeline: {
    category: 'other',
    entity: 'pipeline run',
    label: 'Stopped a Bitbucket pipeline',
    short: 'Stopped a pipeline',
  },

  // ---- WebEx ------------------------------------------------------------
  webex_send_message: {
    category: 'sent',
    entity: 'message',
    label: 'Posted a WebEx message',
    short: 'Posted a message',
  },
  webex_note_to_self: {
    category: 'sent',
    entity: 'note',
    label: 'Left you a WebEx note',
    short: 'Sent you a note',
  },
  webex_capture_message: {
    category: 'created',
    entity: 'message',
    label: 'Captured a WebEx message into Renkei',
    short: 'Captured a message into Renkei',
  },

  // ---- Zoom -------------------------------------------------------------
  zoom_create_meeting: {
    category: 'scheduled',
    entity: 'meeting',
    label: 'Scheduled a Zoom meeting',
    short: 'Scheduled a meeting',
  },
  zoom_update_meeting: {
    category: 'updated',
    entity: 'meeting',
    label: 'Changed a Zoom meeting',
    short: 'Rescheduled or edited a meeting',
  },
  zoom_delete_meeting: {
    category: 'deleted',
    entity: 'meeting',
    label: 'Cancelled a Zoom meeting',
    short: 'Cancelled a meeting',
  },
  zoom_create_doc: {
    category: 'created',
    entity: 'doc',
    label: 'Created a Zoom doc',
    short: 'Created a doc',
  },
  zoom_append_to_doc: {
    category: 'updated',
    entity: 'doc',
    label: 'Added to a Zoom doc',
    short: 'Appended to a doc',
  },

  // ---- SharePoint -------------------------------------------------------
  sharepoint_create_page: {
    category: 'created',
    entity: 'page',
    label: 'Created a SharePoint page',
    short: 'Created a page',
  },
  sharepoint_update_page: {
    category: 'updated',
    entity: 'page',
    label: 'Updated a SharePoint page',
    short: 'Edited a page',
  },
  sharepoint_publish_page: {
    category: 'updated',
    entity: 'page',
    label: 'Published a SharePoint page',
    short: 'Published a draft page',
  },
  sharepoint_delete_page: {
    category: 'deleted',
    entity: 'page',
    label: 'Deleted a SharePoint page',
    short: 'Deleted a page',
  },
  sharepoint_update_document_metadata: {
    category: 'updated',
    entity: 'document',
    label: 'Changed a SharePoint document’s details',
    short: 'Changed a document’s details',
  },
  sharepoint_watch_library: {
    category: 'updated',
    entity: 'library',
    label: 'Started indexing a SharePoint library',
    short: 'Started indexing a document library',
  },
  sharepoint_unwatch_library: {
    category: 'updated',
    entity: 'library',
    label: 'Stopped indexing a SharePoint library',
    short: 'Stopped indexing a document library',
  },
  ...documentActs('sharepoint', 'SharePoint'),

  // ---- OneDrive ---------------------------------------------------------
  ...documentActs('onedrive', 'OneDrive'),

  // ---- Renkei’s own -----------------------------------------------------
  knowledge_create_note: {
    category: 'created',
    entity: 'note',
    label: 'Saved a note',
    short: 'Saved a note',
  },
  knowledge_update_note: {
    category: 'updated',
    entity: 'note',
    label: 'Updated a note',
    short: 'Edited a note',
  },
  knowledge_delete_note: {
    category: 'deleted',
    entity: 'note',
    label: 'Deleted a note',
    short: 'Deleted a note',
  },
  card_create: {
    category: 'created',
    entity: 'card',
    label: 'Left you a card',
    short: 'Put a card on your feed',
  },
  card_update: {
    category: 'updated',
    entity: 'card',
    label: 'Updated one of your cards',
    short: 'Updated a card',
  },
  card_dismiss: {
    category: 'updated',
    entity: 'card',
    label: 'Dismissed one of your cards',
    short: 'Dismissed a card',
  },
  card_archive: {
    category: 'updated',
    entity: 'card',
    label: 'Archived one of your cards',
    short: 'Archived a card',
  },
  agent_create: {
    category: 'created',
    entity: 'agent',
    label: 'Created an agent',
    short: 'Created an agent',
  },
  agent_update: {
    category: 'updated',
    entity: 'agent',
    label: 'Updated an agent',
    short: 'Updated an agent',
  },
  agent_knowledge_write: {
    category: 'created',
    entity: 'note',
    label: 'Added knowledge to an agent',
    short: 'Added knowledge to an agent',
  },
  agent_knowledge_update: {
    category: 'updated',
    entity: 'note',
    label: 'Rewrote an agent’s knowledge note',
    short: 'Rewrote a knowledge note',
  },
  agent_knowledge_remove: {
    category: 'deleted',
    entity: 'note',
    label: 'Removed an agent’s knowledge note',
    short: 'Removed a knowledge note',
  },
  agent_memory_forget: {
    category: 'deleted',
    entity: 'memory',
    label: 'Forgot part of an agent’s memory',
    short: 'Forgot agent memory',
  },
  fileshare_request_file_upload: {
    category: 'created',
    entity: 'file',
    label: 'Requested a file upload to a network share',
    short: 'Requested a share upload',
  },
  fileshare_create_folder: {
    category: 'created',
    entity: 'folder',
    label: 'Created a folder on a network share',
    short: 'Created a share folder',
  },
  fileshare_move_entry: {
    category: 'updated',
    entity: 'file',
    label: 'Moved a file or folder on a network share',
    short: 'Moved a share entry',
  },
  fileshare_rename_entry: {
    category: 'updated',
    entity: 'file',
    label: 'Renamed a file or folder on a network share',
    short: 'Renamed a share entry',
  },
  // fileshare_delete_entry_preview / _confirm are deliberately absent: the
  // confirm is the app's own card button, which an agent run never calls
  // (see the note above the Jira preview/confirm exclusions).
};

/** One connector's acts, in the order the preferences page lists them. */
export interface ConnectorActs {
  connector: string;
  acts: { tool: string; short: string; category: ActCategory }[];
}

/**
 * The catalog regrouped for a preferences page: connector, then the acts
 * that connector can perform.
 *
 * A grid of connector × category was the first attempt and it did not
 * survive contact — it asked what "Scheduled" means for Jira, and the
 * honest answer was "nothing". Acts do not distribute evenly across
 * categories; each connector does a different handful of specific things,
 * and those things are what a person has an opinion about.
 *
 * Categories survive as the ORDER within a connector (created, sent,
 * changed, deleted, scheduled) and as the default for an act nobody has
 * chosen for — both jobs they are good at, neither of them a grid.
 */
export function actsByConnector(): ConnectorActs[] {
  const groups = new Map<string, ConnectorActs>();
  for (const [tool, descriptor] of Object.entries(ACT_OUTCOMES)) {
    const connector = connectorKeyForTool(tool);
    if (!connector) continue;
    const group = groups.get(connector) ?? { connector, acts: [] };
    group.acts.push({ tool, short: descriptor.short, category: descriptor.category });
    groups.set(connector, group);
  }
  for (const group of groups.values()) {
    // Stable: equal categories keep their declaration order, which is the
    // order a person would list them in.
    group.acts.sort(
      (a, b) => ACT_CATEGORIES.indexOf(a.category) - ACT_CATEGORIES.indexOf(b.category)
    );
  }
  return [...groups.values()];
}

/**
 * Schemes a receipt's link may use. A notification's link is clicked
 * without much thought, so a tool must never be able to put an arbitrary
 * scheme behind one — this is an allowlist, not a denylist. `https://`
 * covers every provider's own web link; `webexteams://` is WebEx's native
 * deep link (see `mcp-tools/webex/index.ts`'s `webexSpaceUrl`), the one
 * other scheme this codebase itself ever builds a receipt out of.
 */
const ALLOWED_URL_SCHEMES = ['https://', 'webexteams://'];

function receiptOf(meta: Record<string, unknown> | undefined): ActReceipt {
  const raw = meta?.[ACT_META_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record: Record<string, unknown> = { ...raw };
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  // A headline is one line. Collapsing whitespace rather than rejecting it
  // keeps a handler that interpolated a subject line usable, while making
  // it impossible to smuggle a second line into a notification.
  const line = (value: unknown) => {
    const text = str(value)?.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
  };
  const url = str(record.url);
  return {
    ...(line(record.id) ? { id: line(record.id) } : {}),
    ...(url && ALLOWED_URL_SCHEMES.some((scheme) => url.startsWith(scheme)) ? { url } : {}),
    ...(line(record.entity) ? { entity: line(record.entity) } : {}),
    ...(line(record.label) ? { label: line(record.label) } : {}),
  };
}

/**
 * A friendly-ish sentence for a tool nobody has curated. Deliberately
 * plain: "Ran jira add attachment" is honest about knowing nothing, where
 * an invented label would imply curation that has not happened.
 */
function genericHeadline(tool: string): string {
  const words = tool.replace(/_/g, ' ').trim();
  return `Ran ${words}`;
}

/**
 * What this call did, or null when the tool only read.
 *
 * `kind` comes from the registration stamp (`renkei/kind`). Passing 'read'
 * yields null, so a caller can hand every call through this and let it
 * decide. A caller that does not KNOW the kind should pass null, which is
 * treated as an act — the conservative reading, matching the capability
 * gate: under-reporting an act is the failure that matters.
 */
export function resolveAct(
  tool: string,
  kind: 'read' | 'act' | null,
  meta?: Record<string, unknown>
): ResolvedAct | null {
  if (kind === 'read') return null;

  const receipt = receiptOf(meta);
  const curated = ACT_OUTCOMES[tool];
  const entity = receipt.entity ?? curated?.entity ?? null;
  // Receipt first, exactly as with the identifier: only the handler saw the
  // response, so only the handler can tell "accepted" from "declined".
  const label = receipt.label ?? curated?.label ?? genericHeadline(tool);

  return {
    category: curated?.category ?? 'other',
    connector: connectorKeyForTool(tool),
    entity,
    headline: receipt.id ? `${label} ${receipt.id}` : label,
    id: receipt.id ?? null,
    url: receipt.url ?? null,
    curated: curated !== undefined,
  };
}
