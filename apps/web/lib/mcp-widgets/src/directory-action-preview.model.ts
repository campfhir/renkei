/**
 * The directory action card's rules (directory-action-preview.ts), with no
 * DOM: what a preview from the ADManager tools shows (or why it shows only
 * an error), which receipt a card opens on instead of its buttons, exactly
 * what Confirm calls, and what the card leaves behind — the receipt and the
 * note to the model — when the person confirms or cancels. The card reads
 * the tool result, passes it here, and draws what comes back; the copy
 * button's label is here too, the clipboard itself stays in the card.
 * Tested in directory-action-preview.model.test.ts.
 */

import { asRecord } from '@renkei/guards';
import { doneStateOf, parseLinks, str, strings, type DoneState } from './ui';

export type GroupTone = 'add' | 'remove' | 'muted';

export interface FieldRow {
  label: string;
  value: string;
  /** The value before this change, shown as "was: …"; absent when unchanged or unknown. */
  oldValue?: string;
}

export interface GroupList {
  label: string;
  groups: string[];
  tone: GroupTone;
  /** The chip class each group in the list is drawn with. */
  chipClass: string;
  /** What follows the label, so the size of a long, scrolled list is plain: "(120)". */
  count: string;
}

export interface Person {
  name: string;
  detail: string;
}

/** A preview the card can act on. */
export interface DirectoryPreview {
  ok: true;
  /** Where this card's decision is kept; '' for a preview with no id (nothing kept). */
  stateKey: string;
  title: string;
  subtitle: string;
  /** The action chip beside the title, or null for none. */
  action: { label: string; chipClass: string } | null;
  person: Person | null;
  /** copy-group-membership's source account, with what it is to this action. */
  secondaryPerson: (Person & { label: string }) | null;
  fields: FieldRow[];
  secret: { label: string; value: string; note: string } | null;
  /** Only the lists with any groups in them. */
  groupLists: GroupList[];
  confirmTool: string;
  confirmLabel: string;
  /** Passed to the confirm tool verbatim — the card edits nothing. */
  confirmArgs: Record<string, unknown>;
}

/** A preview the card can only report: the tool failed or named nothing to confirm. */
export interface BrokenPreview {
  ok: false;
  title: string;
  error: string;
}

const TONE_CLASS: Record<string, string> = {
  positive: 'done',
  caution: 'warn',
  neutral: 'progress',
};

const GROUP_TONE_CLASS: Record<GroupTone, string> = {
  add: 'done',
  remove: 'urgent',
  muted: 'neutral',
};

/** The line every reviewable card carries under its title. */
export const REVIEW_NOTE = 'Review — nothing changes until you confirm.';

function fieldRows(value: unknown): FieldRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = asRecord(row);
    return {
      label: str(record.label),
      value: str(record.value),
      ...(str(record.oldValue) ? { oldValue: str(record.oldValue) } : {}),
    };
  });
}

function groupLists(value: unknown): GroupList[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const groups = strings(record.groups);
    if (groups.length === 0) return [];
    const tone: GroupTone =
      record.tone === 'add' || record.tone === 'remove' || record.tone === 'muted'
        ? record.tone
        : 'muted';
    return [
      {
        label: str(record.label),
        groups,
        tone,
        chipClass: GROUP_TONE_CLASS[tone],
        count: ` (${groups.length})`,
      },
    ];
  });
}

/**
 * What a preview tool's result shows. `errorText` is the result's own text,
 * which is what a failed preview says went wrong.
 */
export function readPreview(
  structuredContent: unknown,
  isError: boolean,
  errorText: string
): DirectoryPreview | BrokenPreview {
  const preview = asRecord(structuredContent);
  const confirmTool = str(preview.confirmTool);
  const title = str(preview.title);
  if (isError || !confirmTool) {
    return {
      ok: false,
      title: title || 'Directory action',
      error: errorText || 'The preview could not be prepared.',
    };
  }

  const previewId = str(preview.previewId);
  const action = str(preview.action);
  const person = asRecord(preview.person);
  const secondary = asRecord(preview.secondaryPerson);
  const secret = asRecord(preview.secret);
  return {
    ok: true,
    // Keyed by the id the preview tool minted for THIS card: a content-based
    // key would let a second preview of the same kind recall the first one's
    // receipt (issue-preview.ts has the same rule).
    stateKey: previewId ? `renkei-preview:${previewId}` : '',
    title,
    subtitle: str(preview.subtitle),
    action: action
      ? { label: action, chipClass: TONE_CLASS[str(preview.tone)] ?? 'neutral' }
      : null,
    person: str(person.name) ? { name: str(person.name), detail: str(person.detail) } : null,
    secondaryPerson: str(secondary.name)
      ? {
          name: str(secondary.name),
          detail: str(secondary.detail),
          label: str(secondary.label) || 'Also involved',
        }
      : null,
    fields: fieldRows(preview.fields),
    secret: str(secret.value)
      ? { label: str(secret.label) || 'Password', value: str(secret.value), note: str(secret.note) }
      : null,
    groupLists: groupLists(preview.groupLists),
    confirmTool,
    confirmLabel: str(preview.confirmLabel) || 'Confirm',
    confirmArgs: asRecord(preview.confirmArgs),
  };
}

/**
 * The receipt a card opens on instead of its buttons, if it was decided:
 * the server's record (the preview's `resolved`, which a decision on
 * another device writes) outranks this browser's own remembered receipt,
 * which is only a same-device fallback for an older server that sends none.
 */
export function openingReceipt(
  structuredContent: unknown,
  remembered: DoneState | null
): DoneState | null {
  return doneStateOf(asRecord(structuredContent).resolved) ?? remembered;
}

/** The tool Confirm calls and what it sends: the preview's own, untouched. */
export function confirmCall(preview: DirectoryPreview): {
  name: string;
  args: Record<string, unknown>;
} {
  return { name: preview.confirmTool, args: preview.confirmArgs };
}

export type Outcome =
  | { ok: true; done: DoneState; context: string }
  /** The line the card shows; its buttons come back so the person can try again. */
  | { ok: false; error: string };

/** What the confirm tool's answer leaves: a receipt and a note, or the reason it failed. */
export function confirmOutcome(
  preview: Pick<DirectoryPreview, 'title' | 'subtitle'>,
  answer: { isError: boolean; text: string }
): Outcome {
  const { text } = answer;
  if (answer.isError) return { ok: false, error: text || 'The action failed' };
  const links = parseLinks(text);
  return {
    ok: true,
    done: {
      icon: 'sent',
      headline: text.split('\n')[0] || 'Done',
      detail: preview.subtitle || preview.title,
      ...(links.length > 0 ? { links } : {}),
    },
    context: `The user confirmed "${preview.title}" on the preview card. Result: ${text}`,
  };
}

/** Cancel calls nothing: the receipt says so, and so does the note to the model. */
export function cancelOutcome(preview: Pick<DirectoryPreview, 'title'>): {
  done: DoneState;
  context: string;
} {
  return {
    done: { icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing changed.' },
    context: `The user cancelled "${preview.title}" from the preview card. Nothing changed.`,
  };
}

/** How long the copy button says what happened before it reads Copy again. */
export const COPY_FEEDBACK_MS = 1500;

/** What the password's copy button last did. */
export type CopyState = 'idle' | 'copied' | 'refused';

export type CopyAction =
  /** The clipboard took the password. */
  | { type: 'copied' }
  /** No clipboard in this frame, or it refused (a sandboxed iframe may). */
  | { type: 'refused' }
  /** COPY_FEEDBACK_MS after either. */
  | { type: 'reset' };

export function copyReducer(_state: CopyState, action: CopyAction): CopyState {
  switch (action.type) {
    case 'copied':
      return 'copied';
    case 'refused':
      return 'refused';
    case 'reset':
      return 'idle';
  }
}

export function copyLabel(state: CopyState): string {
  switch (state) {
    case 'idle':
      return 'Copy';
    case 'copied':
      return 'Copied';
    case 'refused':
      return 'Select to copy';
  }
}
