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
 * What an act did, coarsely — the axis a person actually has an opinion
 * about. "Tell me when something gets created" is a sentence people say;
 * "tell me about jira_add_attachment" is not, which is why the per-tool
 * preference is an override rather than the main control.
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
  /** An absolute https link to the thing, for the notification to point at. */
  url?: string;
  /** Overrides the descriptor's entity, for a tool that acts on several. */
  entity?: string;
}

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
   */
  label: string;
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
    _meta: { [ACT_META_KEY]: { ...receipt } },
  };
}

/**
 * The curated set. Ordered by how much a person cares that it happened:
 * something was created, something was sent, something changed, something
 * was removed, something was scheduled.
 */
export const ACT_OUTCOMES: Record<string, ActOutcomeDescriptor> = {
  // Jira
  jira_create_issue: {
    category: 'created',
    entity: 'issue',
    label: 'Created a Jira issue',
  },
  jira_update_issue: {
    category: 'updated',
    entity: 'issue',
    label: 'Updated a Jira issue',
  },
  jira_transition_issue: {
    category: 'updated',
    entity: 'issue',
    label: 'Moved a Jira issue',
  },
  jira_add_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a Jira issue',
  },
  jira_delete_issue: {
    category: 'deleted',
    entity: 'issue',
    label: 'Deleted a Jira issue',
  },
  jira_log_work: {
    category: 'created',
    entity: 'worklog',
    label: 'Logged work on a Jira issue',
  },

  // Jira Service Management
  jsm_create_request: {
    category: 'created',
    entity: 'request',
    label: 'Raised a service request',
  },
  jsm_transition_request: {
    category: 'updated',
    entity: 'request',
    label: 'Moved a service request',
  },
  jsm_add_request_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a service request',
  },

  // Outlook
  outlook_send_mail: {
    category: 'sent',
    entity: 'email',
    label: 'Sent an email',
  },
  outlook_reply_message: {
    category: 'sent',
    entity: 'email',
    label: 'Replied to an email',
  },
  outlook_reply_all_message: {
    category: 'sent',
    entity: 'email',
    label: 'Replied to all on an email',
  },
  outlook_forward_message: {
    category: 'sent',
    entity: 'email',
    label: 'Forwarded an email',
  },
  outlook_create_event: {
    category: 'scheduled',
    entity: 'meeting',
    label: 'Scheduled a meeting',
  },

  // WebEx
  webex_send_message: {
    category: 'sent',
    entity: 'message',
    label: 'Posted a WebEx message',
  },
  webex_note_to_self: {
    category: 'sent',
    entity: 'note',
    label: 'Left you a WebEx note',
  },

  // Confluence
  confluence_create_page: {
    category: 'created',
    entity: 'page',
    label: 'Created a Confluence page',
  },
  confluence_update_page: {
    category: 'updated',
    entity: 'page',
    label: 'Updated a Confluence page',
  },
  confluence_delete_page: {
    category: 'deleted',
    entity: 'page',
    label: 'Deleted a Confluence page',
  },
  confluence_add_comment: {
    category: 'created',
    entity: 'comment',
    label: 'Commented on a Confluence page',
  },
  confluence_create_blogpost: {
    category: 'created',
    entity: 'blog post',
    label: 'Created a Confluence blog post',
  },

  // Zoom
  zoom_create_meeting: {
    category: 'scheduled',
    entity: 'meeting',
    label: 'Scheduled a Zoom meeting',
  },
  zoom_create_doc: {
    category: 'created',
    entity: 'doc',
    label: 'Created a Zoom doc',
  },

  // Renkei's own
  knowledge_create_note: {
    category: 'created',
    entity: 'note',
    label: 'Saved a note',
  },
  card_create: {
    category: 'created',
    entity: 'card',
    label: 'Left you a card',
  },
};

function receiptOf(meta: Record<string, unknown> | undefined): ActReceipt {
  const raw = meta?.[ACT_META_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record: Record<string, unknown> = { ...raw };
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    ...(str(record.id) ? { id: str(record.id) } : {}),
    // https only. A notification's link is clicked without much thought,
    // and a tool should not be able to put an arbitrary scheme behind one.
    ...(str(record.url)?.startsWith('https://') ? { url: str(record.url) } : {}),
    ...(str(record.entity) ? { entity: str(record.entity) } : {}),
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
  const label = curated?.label ?? genericHeadline(tool);

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
