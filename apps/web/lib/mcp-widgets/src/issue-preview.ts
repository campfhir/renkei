/**
 * Work-item preview card (Jira issues, JSM requests).
 *
 * Deliberately generic where the email card is specific: issue-shaped writes
 * differ only in their field list and which confirm tool they run, so the
 * preview tool ships the whole contract in structuredContent —
 *
 *   { kind: 'issue', title, subtitle?,
 *     confirmTool, confirmLabel, confirmOutcome?,
 *     cancelTool?, cancelLabel?, cancelOutcome?,
 *     confirmArgs,                    // passed through verbatim on confirm
 *     editable?: { summaryKey?, descriptionKey? },   // keys into confirmArgs
 *     fields: [{ label, value, oldValue?, editable? }] }   // display rows
 *
 * — and this one card serves create, update, and JSM request alike. An
 * update's rows carry oldValue so the user sees what changes, not just the
 * end state. Summary/description are always editable via the top-level
 * `editable` keys above; any OTHER row (priority, a custom field, …) is
 * editable only when the preview tool resolved enough about it to say so —
 * `row.editable` names the path into `confirmArgs` to write back to, what
 * kind of control to render, and (for a picklist/checkbox row) the options.
 * A row with no `editable` stays a plain value — project/type never carry
 * one, so the card cannot be used to redirect the write structurally.
 *
 * Cancel is local-only (nothing was written, so there is nothing to tell a
 * host) UNLESS the preview sets `cancelTool` — then Cancel becomes a second
 * confirm-shaped button: same field edits gathered, `cancelTool` called
 * instead of `confirmTool`. This is what lets a host outside chat (an
 * agent's approval card, never chat's own preview tools, which never set
 * this) reuse Cancel AS its decline, instead of the card needing a second,
 * redundant "no" control next to it. `confirmLabel`/`cancelLabel` are the
 * button TEXT, free to read naturally in whatever surface hosts the card
 * ("Create"/"Cancel" in chat); `confirmOutcome`/`cancelOutcome` are a
 * separate, optional semantic tag ("approved"/"declined", or anything else
 * a future host cares about) a generic chat host has no reason to read but
 * a decision-shaped host can, without needing to know Jira- or
 * email-specific tool names to tell two buttons apart.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  checkboxGroupField,
  el,
  injectStyle,
  inputField,
  numberField,
  parseLinks,
  recallDone,
  rememberDone,
  renderDone,
  selectField,
  str,
  textField,
  type DoneState,
  type FieldOption,
} from './ui';

interface FieldEdit {
  path: string[];
  kind: 'text' | 'text-array' | 'number' | 'select' | 'checkboxes';
  value: string | string[];
  options: FieldOption[];
}

interface FieldRow {
  label: string;
  value: string;
  oldValue?: string;
  editable?: FieldEdit;
}

function asRecord(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

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

function fieldEditOf(record: Record<string, unknown>): FieldEdit | undefined {
  const raw = asRecord(record.editable);
  const path = strings(raw.path);
  const kind = raw.kind;
  if (
    path.length === 0 ||
    (kind !== 'text' &&
      kind !== 'text-array' &&
      kind !== 'number' &&
      kind !== 'select' &&
      kind !== 'checkboxes')
  ) {
    return undefined;
  }
  return {
    path,
    kind,
    value: kind === 'checkboxes' ? strings(raw.value) : str(raw.value),
    options: fieldOptions(raw.options),
  };
}

/**
 * Set `value` at `path` inside `obj`, copying each object the path passes
 * through rather than mutating it in place — `confirmArgs` (and its nested
 * `fields`) stays the object the bridge handed this render, untouched,
 * even though several edits may each set a different path into it.
 */
function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let target = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = asRecord(target[key]);
    const copy = { ...next };
    target[key] = copy;
    target = copy;
  }
  target[path[path.length - 1]!] = value;
}

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const preview = asRecord(result.structuredContent);
  const confirmTool = str(preview.confirmTool);
  const confirmArgs = asRecord(preview.confirmArgs);

  const card = el('div', 'card');
  if (result.isError || !confirmTool) {
    card.append(
      el('div', 'card-title', str(preview.title) || 'Preview'),
      el('div', 'status error', resultText(result) || 'The preview could not be prepared.')
    );
    root.append(card);
    return;
  }

  // Keyed by the id the preview tool minted for THIS card. It used to be
  // the confirm tool plus a slice of its arguments, so a second preview of
  // the same kind recalled the first one's receipt and rendered as already
  // cancelled — no fields, no button, and no way back short of clearing
  // localStorage.
  //
  // No id means an older server: render the live card rather than risk
  // recalling someone else's outcome. Forgetting a cancellation costs one
  // extra click; showing a stale one makes the tool unusable.
  const previewId = str(preview.previewId);
  const stateKey = previewId ? `renkei-preview:${previewId}` : '';
  const remembered = stateKey ? recallDone(stateKey) : null;
  if (remembered) {
    renderDone(root, remembered);
    return;
  }
  const finishDone = (state: DoneState) => {
    if (stateKey) rememberDone(stateKey, state);
    renderDone(root, state);
  };

  card.append(el('div', 'card-title', str(preview.title)));
  if (str(preview.subtitle)) card.append(el('div', 'card-subtitle', str(preview.subtitle)));
  card.append(el('div', 'card-subtitle', 'Review — nothing is written until you confirm.'));

  const editable = asRecord(preview.editable);
  const summaryKey = str(editable.summaryKey);
  const descriptionKey = str(editable.descriptionKey);
  const summaryInput = summaryKey ? inputField('Summary', str(confirmArgs[summaryKey])) : null;
  if (summaryInput) card.append(summaryInput.field);

  const rows: FieldRow[] = Array.isArray(preview.fields)
    ? preview.fields.map((row) => {
        const record = asRecord(row);
        const editable = fieldEditOf(record);
        return {
          label: str(record.label),
          value: str(record.value),
          ...(str(record.oldValue) ? { oldValue: str(record.oldValue) } : {}),
          ...(editable ? { editable } : {}),
        };
      })
    : [];
  // One read() per editable row, gathered on confirm rather than per
  // keystroke — the control IS the state, this just knows how to read it.
  const fieldEdits: { path: string[]; read: () => unknown }[] = [];
  for (const row of rows) {
    if (!row.editable) {
      const field = el('div', 'field');
      field.append(el('div', 'field-label', row.label));
      field.append(el('div', 'field-value', row.value));
      if (row.oldValue) field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
      card.append(field);
      continue;
    }
    const edit = row.editable;
    let built: { field: HTMLElement };
    if (edit.kind === 'select') {
      const control = selectField(row.label, str(edit.value), edit.options);
      built = control;
      fieldEdits.push({ path: edit.path, read: () => control.input.value });
    } else if (edit.kind === 'checkboxes') {
      const control = checkboxGroupField(
        row.label,
        Array.isArray(edit.value) ? edit.value : [],
        edit.options
      );
      built = control;
      fieldEdits.push({ path: edit.path, read: () => control.getValues() });
    } else if (edit.kind === 'number') {
      const control = numberField(row.label, str(edit.value));
      built = control;
      fieldEdits.push({
        path: edit.path,
        read: () => (control.input.value.trim() ? Number(control.input.value) : null),
      });
    } else if (edit.kind === 'text-array') {
      const control = inputField(row.label, str(edit.value));
      built = control;
      fieldEdits.push({
        path: edit.path,
        read: () =>
          control.input.value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
      });
    } else {
      const control = inputField(row.label, str(edit.value));
      built = control;
      fieldEdits.push({ path: edit.path, read: () => control.input.value.trim() });
    }
    if (row.oldValue) built.field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
    card.append(built.field);
  }

  const descriptionInput = descriptionKey
    ? textField('Description (markdown)', str(confirmArgs[descriptionKey]))
    : null;
  if (descriptionInput) card.append(descriptionInput.field);

  // Present only when a host wants Cancel to BE a real decision instead of
  // a purely local dismissal — an approval card's Decline, leveraging the
  // same button rather than duplicating it (see approval-preview.ts).
  // Absent (every existing chat preview), Cancel keeps its original,
  // unconditionally local behavior below — nothing about this changes for
  // a card that never sets it.
  const cancelTool = str(preview.cancelTool);
  const cancelButton = el('button', undefined, str(preview.cancelLabel) || 'Cancel');
  const confirmButton = el('button', 'primary', str(preview.confirmLabel) || 'Confirm');
  const footer = cardActions([cancelButton, confirmButton]);
  card.append(footer.actions);
  root.append(card);

  const gatherArgs = (): Record<string, unknown> => {
    const args = { ...confirmArgs };
    if (summaryInput && summaryKey) {
      args[summaryKey] = summaryInput.input.value.trim() || str(confirmArgs[summaryKey]);
    }
    if (descriptionInput && descriptionKey) {
      const value = descriptionInput.input.value.trim();
      if (value) args[descriptionKey] = value;
      else delete args[descriptionKey];
    }
    for (const edit of fieldEdits) setPath(args, edit.path, edit.read());
    return args;
  };

  footer.run(confirmButton, async () => {
    const confirmed = await bridge.callTool(confirmTool, gatherArgs());
    const text = resultText(confirmed);
    if (confirmed.isError) throw new Error(text || 'The write failed');
    // First line only on the card ("Created issue SCRUM-42"); the model gets
    // the whole result — it needs the key and link for its next reply.
    // Whatever the confirm tool linked to — the issue, and for a JSM
    // request the customer portal as well — so the thing just created can
    // be opened from the card instead of scrolled back for.
    const links = parseLinks(text);
    finishDone({
      icon: 'sent',
      headline: text.split('\n')[0] || 'Done',
      detail: str(preview.subtitle) || str(preview.title),
      ...(links.length > 0 ? { links } : {}),
    });
    bridge.updateModelContext(
      `The user confirmed "${str(preview.title)}" on the preview card. Result: ${text}`
    );
  });

  footer.run(cancelButton, async () => {
    if (!cancelTool) {
      finishDone({ icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing was written.' });
      bridge.updateModelContext(
        `The user cancelled "${str(preview.title)}" from the preview card. Nothing was written.`
      );
      return;
    }
    const declined = await bridge.callTool(cancelTool, gatherArgs());
    const text = resultText(declined);
    if (declined.isError) throw new Error(text || 'The request failed');
    finishDone({
      icon: 'cancelled',
      headline: text.split('\n')[0] || 'Cancelled',
      detail: str(preview.subtitle) || str(preview.title),
    });
    bridge.updateModelContext(
      `The user declined "${str(preview.title)}" from the preview card. Result: ${text}`
    );
  });
}

const bridge = new WidgetBridge('renkei-issue-preview');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
