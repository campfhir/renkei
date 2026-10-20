/**
 * The data contract between an act tool's preview (server side,
 * lib/mcp-tools/previews/) and the act-preview card that draws it
 * (act-preview.ts). Types only — the server imports them with
 * `import type`, the widget bundle imports them for its renderers — so the
 * two sides cannot disagree about a field without the compiler saying so.
 *
 * ## Why a card per KIND of act, not one card for all
 *
 * An argument list ("Page id: 98765, Draft: false") makes a person do the
 * translating from parameters back to the act. Each kind below is drawn the
 * way the thing it changes looks: a comment is a comment with the thing it
 * is on and the words in it; a transition is a status going from one
 * lozenge to another; a worklog is a duration; a link is two issues with
 * the relationship between them; a commit is a list of files with what
 * happens to each. Every tool picks the kind that fits and supplies its own
 * wording and parts (previews/*.ts) — there is no fallback that prints the
 * arguments, and a test fails when an act tool has no card.
 *
 * Every card carries the same shell (title, system, the verb chip, the tone
 * of that verb) and the same footer, so the cards read as one family.
 */

export type Tone = 'positive' | 'neutral' | 'caution' | 'danger';

export type IconName =
  | 'comment'
  | 'check'
  | 'cross'
  | 'arrow'
  | 'clock'
  | 'link'
  | 'user'
  | 'users'
  | 'doc'
  | 'folder'
  | 'branch'
  | 'commit'
  | 'calendar'
  | 'mail'
  | 'play'
  | 'stop'
  | 'flag'
  | 'trash'
  | 'tag'
  | 'gear'
  | 'sprint'
  | 'merge'
  | 'bell'
  | 'upload';

/** A thing in another system, named the way a person says it: `PROJ-12` and what it is. */
export interface Ref {
  label: string;
  title?: string;
  /** Where it lives — the space, the repository, the project. */
  context?: string;
}

/** A field of the call a person may rewrite on the card before confirming. */
export interface Editable {
  /** The confirm tool's argument this field writes. */
  key: string;
  label: string;
  multiline?: boolean;
}

/** One line of a `change` card: a value, a before and after, or things added and removed. */
export interface Row {
  label: string;
  value?: string;
  from?: string;
  add?: string[];
  remove?: string[];
  /** Preformatted or long text, kept as written in a bordered block. */
  block?: boolean;
}

export interface Person {
  name: string;
  detail?: string;
  kind?: 'user' | 'group' | 'email';
}

export interface FileChange {
  path: string;
  status: 'add' | 'modify' | 'delete';
  lines?: number;
  /** The first lines of the file, when there is one file and it is short. */
  peek?: string;
}

export interface Attendee {
  name: string;
  optional?: boolean;
  removed?: boolean;
}

export type CommentBody = {
  kind: 'comment';
  mode: 'add' | 'edit' | 'delete' | 'resolve' | 'reopen' | 'task' | 'note';
  on: Ref;
  /** Argument holding the words, when they can be edited. */
  bodyKey?: string;
  body?: string;
  /** "Internal note", "Reply", "Inline" — who sees it and how it is attached. */
  badges?: string[];
  /** The code or text an inline comment is anchored to. */
  anchor?: { file?: string; line?: number; text?: string };
  /** The comment being edited, deleted or resolved. */
  commentId?: string;
};

export type VerdictBody = {
  kind: 'verdict';
  verdict: 'approve' | 'changes' | 'decline' | 'close' | 'unapprove' | 'unchange';
  pullRequest: Ref;
  bodyKey?: string;
  body?: string;
};

export type TransitionBody = {
  kind: 'transition';
  /** What moves: one item, or a query that selects several. */
  subject?: Ref;
  query?: string;
  /** What the status is of — "Status", "Page status", "Task". */
  field: string;
  from?: string;
  to: string;
  noteKey?: string;
  note?: string;
};

export type WorklogBody = {
  kind: 'worklog';
  mode: 'log' | 'delete';
  on: Ref;
  duration?: string;
  started?: string;
  worklogId?: string;
  bodyKey?: string;
  body?: string;
};

export type LinkBody = {
  kind: 'link';
  mode: 'create' | 'delete';
  from?: Ref;
  relation: string;
  to?: Ref;
  /** An external page rather than another item. */
  url?: { href: string; title: string };
  linkId?: string;
};

export type AccessBody = {
  kind: 'access';
  mode: 'grant' | 'revoke' | 'invite' | 'add' | 'remove' | 'watch' | 'unwatch' | 'share';
  who: Person[];
  level?: string;
  on: Ref;
  /** Link options, expiry, a message to the people. */
  details?: { label: string; value: string }[];
  bodyKey?: string;
  body?: string;
};

export type DocumentBody = {
  kind: 'document';
  mode: 'create' | 'update' | 'append' | 'publish' | 'delete';
  type: string;
  titleKey?: string;
  title?: string;
  /** Breadcrumb: where it lives. */
  location?: string[];
  status?: string;
  bodyKey?: string;
  body?: string;
  bodyLabel?: string;
  versionNote?: string;
  /** For an edit that names only some fields, what the card could not show. */
  unchanged?: string;
};

export type FileItem = { name: string; path?: string; type: 'file' | 'folder' | 'attachment' };

export type FileOpBody = {
  kind: 'fileop';
  mode: 'create' | 'move' | 'rename' | 'copy' | 'delete' | 'attach';
  items: FileItem[];
  to?: { name?: string; path?: string };
  note?: string;
  details?: { label: string; value: string }[];
};

export type ChangeBody = {
  kind: 'change';
  subject: Ref;
  rows: Row[];
  /** Plain sentences under the rows: what else happens, what cannot be undone. */
  notes?: string[];
};

export type CommitBody = {
  kind: 'commit';
  repo: string;
  branch: string;
  messageKey: string;
  message: string;
  files: FileChange[];
  omitted?: number;
};

export type BranchBody = {
  kind: 'branch';
  mode: 'create' | 'delete';
  repo: string;
  name: string;
  base?: string;
};

export type PipelineBody = {
  kind: 'pipeline';
  mode: 'stop' | 'cancel';
  repo: string;
  run: string;
  ref?: string;
};

export type SprintBody = {
  kind: 'sprint';
  mode: 'create' | 'complete' | 'move' | 'remove';
  sprint?: {
    name?: string;
    id?: string;
    board?: string;
    start?: string;
    end?: string;
    goal?: string;
  };
  issues?: string[];
};

export type EventBody = {
  kind: 'event';
  mode: 'create' | 'update' | 'respond' | 'delete';
  subject?: string;
  start?: string;
  end?: string;
  timezone?: string;
  where?: string;
  online?: boolean;
  recurrence?: string;
  attendees?: Attendee[];
  response?: 'accept' | 'tentative' | 'decline';
  /** Update of a series versus one occurrence, or what a delete reaches. */
  scope?: string;
  bodyKey?: string;
  body?: string;
  /** Fields an update leaves alone are not shown; this says it. */
  note?: string;
};

export type MailboxBody = {
  kind: 'mailbox';
  mode:
    | 'read'
    | 'unread'
    | 'flag'
    | 'unflag'
    | 'complete'
    | 'categorize'
    | 'move'
    | 'archive'
    | 'folder-create'
    | 'folder-rename'
    | 'folder-delete'
    | 'bulk';
  /** How many messages, or what selects them. */
  messages?: string;
  folder?: string;
  to?: string;
  categories?: { add?: string[]; remove?: string[]; replace?: string[] };
  filters?: { label: string; value: string }[];
};

export type ActBody =
  | CommentBody
  | VerdictBody
  | TransitionBody
  | WorklogBody
  | LinkBody
  | AccessBody
  | DocumentBody
  | FileOpBody
  | ChangeBody
  | CommitBody
  | BranchBody
  | PipelineBody
  | SprintBody
  | EventBody
  | MailboxBody;

/** What a tool's builder returns: the shell and the body, before the server adds ids. */
export interface ActCardSpec {
  /** The verb on the chip and the default confirm button ("Post comment", "Delete"). */
  verb: string;
  tone?: Tone;
  icon: IconName;
  /** The headline: "Comment on PROJ-12". */
  title: string;
  /** The system and place: "Jira · Acme". */
  subtitle?: string;
  confirmLabel?: string;
  editable?: Editable[];
  body: ActBody;
}

/** The structuredContent a generated preview tool answers with. */
export interface ActCard extends ActCardSpec {
  /** Tells the card bundle this is its payload (and not an older card's). */
  kind: 'act';
  previewId: string;
  confirmTool: string;
  confirmArgs: Record<string, unknown>;
}
