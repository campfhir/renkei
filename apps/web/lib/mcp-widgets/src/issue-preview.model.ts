/**
 * The work-item card's rules (issue-preview.ts), with no DOM and no
 * storage of its own: what a preview becomes on screen (an error, the
 * receipt of a decision already made, or the live form), which rows are
 * editable and as what, exactly what Confirm or a host's Cancel sends,
 * and what each answer leaves on the card and tells the model. The card
 * reads its controls, passes their values in, and renders what comes
 * back. Tested in issue-preview.model.test.ts.
 */

import { asRecord } from '@renkei/guards';
import { resultText, type ToolResult } from './bridge';
import { doneStateOf, parseLinks, str, type DoneState, type FieldOption } from './ui';

export type FieldKind = 'text' | 'text-array' | 'number' | 'select' | 'checkboxes' | 'chips';

const FIELD_KINDS: readonly string[] = [
  'text',
  'text-array',
  'number',
  'select',
  'checkboxes',
  'chips',
] satisfies FieldKind[];

const isFieldKind = (value: unknown): value is FieldKind =>
  typeof value === 'string' && FIELD_KINDS.includes(value);

/** How a row may be edited: where its value goes in the confirm arguments, and as what control. */
export interface FieldEdit {
  path: string[];
  kind: FieldKind;
  /** A list for checkboxes and chips, a string otherwise. */
  value: string | string[];
  options: FieldOption[];
}

export interface FieldRow {
  label: string;
  value: string;
  /** An update's current value, shown as "was: …". */
  oldValue?: string;
  editable?: FieldEdit;
}

/** A preview the card can act on. */
export interface IssuePreview {
  title: string;
  subtitle: string;
  confirmTool: string;
  confirmLabel: string;
  /** Empty: Cancel is local. Set: Cancel is a second confirm-shaped call (an approval's Decline). */
  cancelTool: string;
  cancelLabel: string;
  /** Passed through verbatim on confirm, with the card's edits laid over it. */
  confirmArgs: Record<string, unknown>;
  summaryKey: string;
  descriptionKey: string;
  rows: FieldRow[];
  /** The card's own key (`renkei-preview:<previewId>`), or '' for a preview from an older server. */
  stateKey: string;
}

export type IssueCard =
  | { kind: 'error'; title: string; message: string }
  | { kind: 'receipt'; state: DoneState }
  | { kind: 'live'; preview: IssuePreview };

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function fieldOptions(value: unknown): FieldOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const optionValue = str(record.value);
    return optionValue ? [{ label: str(record.label) || optionValue, value: optionValue }] : [];
  });
}

/** A row's `editable`, when the preview said enough to edit it; otherwise it is a plain value. */
export function fieldEditOf(record: Record<string, unknown>): FieldEdit | undefined {
  const raw = asRecord(record.editable);
  const path = strings(raw.path);
  const kind = raw.kind;
  if (path.length === 0 || !isFieldKind(kind)) return undefined;
  return {
    path,
    kind,
    value: kind === 'checkboxes' || kind === 'chips' ? strings(raw.value) : str(raw.value),
    options: fieldOptions(raw.options),
  };
}

function rowsOf(value: unknown): FieldRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = asRecord(row);
    const editable = fieldEditOf(record);
    return {
      label: str(record.label),
      value: str(record.value),
      ...(str(record.oldValue) ? { oldValue: str(record.oldValue) } : {}),
      ...(editable ? { editable } : {}),
    };
  });
}

/**
 * The card's key, minted by the preview tool for THIS card. It used to be
 * the confirm tool plus a slice of its arguments, so a second preview of
 * the same kind recalled the first one's receipt and rendered as already
 * cancelled. No id means an older server: no key, so nothing is recalled
 * — forgetting a cancellation costs one extra click; showing a stale one
 * makes the tool unusable.
 */
export function stateKeyOf(previewId: string): string {
  return previewId ? `renkei-preview:${previewId}` : '';
}

/**
 * What a tool result shows: an error card, the receipt of a decision
 * already made (the server's `resolved` first, then what this browser
 * remembers under the card's key — `recall`, asked only when there is a
 * key and no `resolved`), or the live form.
 */
export function issueCardOf(
  result: ToolResult,
  recall: (stateKey: string) => DoneState | null
): IssueCard {
  const preview = asRecord(result.structuredContent);
  const confirmTool = str(preview.confirmTool);
  if (result.isError || !confirmTool) {
    return {
      kind: 'error',
      title: str(preview.title) || 'Preview',
      message: resultText(result) || 'The preview could not be prepared.',
    };
  }
  const stateKey = stateKeyOf(str(preview.previewId));
  const remembered = doneStateOf(preview.resolved) ?? (stateKey ? recall(stateKey) : null);
  if (remembered) return { kind: 'receipt', state: remembered };
  const editable = asRecord(preview.editable);
  return {
    kind: 'live',
    preview: {
      title: str(preview.title),
      subtitle: str(preview.subtitle),
      confirmTool,
      confirmLabel: str(preview.confirmLabel) || 'Confirm',
      cancelTool: str(preview.cancelTool),
      cancelLabel: str(preview.cancelLabel) || 'Cancel',
      confirmArgs: asRecord(preview.confirmArgs),
      summaryKey: str(editable.summaryKey),
      descriptionKey: str(editable.descriptionKey),
      rows: rowsOf(preview.fields),
      stateKey,
    },
  };
}

/** The Summary box's starting text, or null when the card has no Summary box. */
export function summaryValue(preview: IssuePreview): string | null {
  return preview.summaryKey ? str(preview.confirmArgs[preview.summaryKey]) : null;
}

/** The Description box's starting text, or null when the card has no Description box. */
export function descriptionValue(preview: IssuePreview): string | null {
  return preview.descriptionKey ? str(preview.confirmArgs[preview.descriptionKey]) : null;
}

/**
 * What an editable row's control holds, as the confirm tool takes it: a
 * number box's number (empty is null, not zero), a list box split on
 * commas, a text box trimmed, a pick list's value and a multi-select's
 * values as they are.
 */
export function fieldValue(kind: FieldKind, raw: string | string[]): unknown {
  if (Array.isArray(raw)) return raw;
  switch (kind) {
    case 'number':
      return raw.trim() ? Number(raw) : null;
    case 'text-array':
      return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    case 'text':
      return raw.trim();
    default:
      return raw;
  }
}

/**
 * Set `value` at `path` inside `obj`, copying each object the path passes
 * through rather than mutating it in place — `confirmArgs` (and its nested
 * `fields`) stays the object the preview handed over, untouched, even
 * though several edits may each set a different path into it.
 */
function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let target = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const copy = { ...asRecord(target[key]) };
    target[key] = copy;
    target = copy;
  }
  target[path[path.length - 1]!] = value;
}

/** The card's controls as the person left them. */
export interface IssueInputs {
  /** The Summary box, or null when there is none. */
  summary: string | null;
  /** The Description box, or null when there is none. */
  description: string | null;
  /** Each editable row's control, read raw. */
  fields: { edit: FieldEdit; raw: string | string[] }[];
}

/**
 * The arguments a press sends: the preview's own, with the edits laid
 * over them. A summary cleared to nothing keeps the preview's; a
 * description cleared to nothing is left out.
 */
export function gatherArgs(preview: IssuePreview, inputs: IssueInputs): Record<string, unknown> {
  const { confirmArgs, summaryKey, descriptionKey } = preview;
  const args = { ...confirmArgs };
  if (inputs.summary !== null && summaryKey) {
    args[summaryKey] = inputs.summary.trim() || str(confirmArgs[summaryKey]);
  }
  if (inputs.description !== null && descriptionKey) {
    const value = inputs.description.trim();
    if (value) args[descriptionKey] = value;
    else delete args[descriptionKey];
  }
  for (const { edit, raw } of inputs.fields) setPath(args, edit.path, fieldValue(edit.kind, raw));
  return args;
}

export type Press = 'confirm' | 'cancel';

/** What the card shows once decided, and what the model is told. */
export interface Settled {
  receipt: DoneState;
  context: string;
}

/** What a press does before anything reaches a server. */
export type PressPlan =
  /** Run a tool with these arguments, then `settle` its answer. */
  | { kind: 'call'; name: string; args: Record<string, unknown> }
  /** Cancel with no cancel tool: nothing was written, so nothing is called. */
  | ({ kind: 'local' } & Settled);

export function planPress(preview: IssuePreview, press: Press, inputs: IssueInputs): PressPlan {
  if (press === 'confirm') {
    return { kind: 'call', name: preview.confirmTool, args: gatherArgs(preview, inputs) };
  }
  if (!preview.cancelTool) {
    return {
      kind: 'local',
      receipt: { icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing was written.' },
      context: `The user cancelled "${preview.title}" from the preview card. Nothing was written.`,
    };
  }
  return { kind: 'call', name: preview.cancelTool, args: gatherArgs(preview, inputs) };
}

/**
 * What a tool's answer leaves on the card: the line shown beside the
 * buttons when it failed, or the receipt and the model's note. The card
 * shows the first line of the result ("Created issue SCRUM-42") with
 * whatever it linked to; the model gets the whole result, since it needs
 * the key and link for its next reply.
 */
export function settle(
  preview: IssuePreview,
  press: Press,
  result: ToolResult
): ({ ok: true } & Settled) | { ok: false; error: string } {
  const text = resultText(result);
  const detail = preview.subtitle || preview.title;
  if (press === 'confirm') {
    if (result.isError) return { ok: false, error: text || 'The write failed' };
    const links = parseLinks(text);
    return {
      ok: true,
      receipt: {
        icon: 'sent',
        headline: text.split('\n')[0] || 'Done',
        detail,
        ...(links.length > 0 ? { links } : {}),
      },
      context: `The user confirmed "${preview.title}" on the preview card. Result: ${text}`,
    };
  }
  if (result.isError) return { ok: false, error: text || 'The request failed' };
  return {
    ok: true,
    receipt: { icon: 'cancelled', headline: text.split('\n')[0] || 'Cancelled', detail },
    context: `The user declined "${preview.title}" from the preview card. Result: ${text}`,
  };
}
