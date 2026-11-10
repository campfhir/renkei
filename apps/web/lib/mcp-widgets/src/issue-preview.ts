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
 * kind of control to render, and (for a picklist/checkbox/chips row) the
 * options. `chips` is a combo box whose picks collect as removable chips,
 * for a multi-select with many options (a desk's components).
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
 *
 * Those rules — what a preview shows, what a press sends, what each
 * answer leaves on the card — are issue-preview.model.ts, tested in node
 * (issue-preview.model.test.ts); this file draws the card and wires it.
 */

import { WidgetBridge, type ToolResult } from './bridge';
import {
  cardActions,
  checkboxGroupField,
  chipsField,
  el,
  injectStyle,
  inputField,
  numberField,
  recallDone,
  rememberDone,
  renderDone,
  selectField,
  str,
  textField,
  type DoneState,
} from './ui';
import {
  descriptionValue,
  issueCardOf,
  planPress,
  settle,
  summaryValue,
  type FieldEdit,
  type IssueInputs,
  type Press,
} from './issue-preview.model';

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  // What the result shows, and every rule below, is issue-preview.model.ts.
  const shown = issueCardOf(result, recallDone);
  if (shown.kind === 'error') {
    const card = el('div', 'card');
    card.append(el('div', 'card-title', shown.title), el('div', 'status error', shown.message));
    root.append(card);
    return;
  }
  if (shown.kind === 'receipt') {
    renderDone(root, shown.state);
    return;
  }
  const preview = shown.preview;
  const { stateKey } = preview;
  const finishDone = (state: DoneState) => {
    if (stateKey) {
      rememberDone(stateKey, state);
      bridge.reportDecision(stateKey, state);
    }
    renderDone(root, state);
  };

  const card = el('div', 'card');
  card.append(el('div', 'card-title', preview.title));
  if (preview.subtitle) card.append(el('div', 'card-subtitle', preview.subtitle));
  card.append(el('div', 'card-subtitle', 'Review — nothing is written until you confirm.'));

  const summary = summaryValue(preview);
  const summaryInput = summary !== null ? inputField('Summary', summary) : null;
  if (summaryInput) card.append(summaryInput.field);

  // One read() per editable row, gathered on a press rather than per
  // keystroke — the control IS the state, this just knows how to read it.
  const fieldReads: { edit: FieldEdit; read: () => string | string[] }[] = [];
  for (const row of preview.rows) {
    if (!row.editable) {
      const field = el('div', 'field');
      field.append(el('div', 'field-label', row.label));
      field.append(el('div', 'field-value', row.value));
      if (row.oldValue) field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
      card.append(field);
      continue;
    }
    const edit = row.editable;
    const list = Array.isArray(edit.value) ? edit.value : [];
    let built: { field: HTMLElement };
    if (edit.kind === 'select') {
      const control = selectField(row.label, str(edit.value), edit.options);
      built = control;
      fieldReads.push({ edit, read: () => control.input.value });
    } else if (edit.kind === 'checkboxes') {
      const control = checkboxGroupField(row.label, list, edit.options);
      built = control;
      fieldReads.push({ edit, read: () => control.getValues() });
    } else if (edit.kind === 'chips') {
      const control = chipsField(row.label, list, edit.options);
      built = control;
      fieldReads.push({ edit, read: () => control.getValues() });
    } else if (edit.kind === 'number') {
      const control = numberField(row.label, str(edit.value));
      built = control;
      fieldReads.push({ edit, read: () => control.input.value });
    } else {
      const control = inputField(row.label, str(edit.value));
      built = control;
      fieldReads.push({ edit, read: () => control.input.value });
    }
    if (row.oldValue) built.field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
    card.append(built.field);
  }

  const description = descriptionValue(preview);
  const descriptionInput =
    description !== null ? textField('Description (markdown)', description) : null;
  if (descriptionInput) card.append(descriptionInput.field);

  const cancelButton = el('button', undefined, preview.cancelLabel);
  const confirmButton = el('button', 'primary', preview.confirmLabel);
  const footer = cardActions([cancelButton, confirmButton]);
  card.append(footer.actions);
  root.append(card);

  const inputs = (): IssueInputs => ({
    summary: summaryInput ? summaryInput.input.value : null,
    description: descriptionInput ? descriptionInput.input.value : null,
    fields: fieldReads.map(({ edit, read }) => ({ edit, raw: read() })),
  });

  const press = async (which: Press) => {
    const plan = planPress(preview, which, inputs());
    let outcome;
    if (plan.kind === 'local') {
      outcome = plan;
    } else {
      // A refusal from the host (another device already decided this
      // card) rejects here, and cardActions shows its words.
      const answered = settle(
        preview,
        which,
        await bridge.callTool(plan.name, plan.args, stateKey)
      );
      if (!answered.ok) throw new Error(answered.error);
      outcome = answered;
    }
    finishDone(outcome.receipt);
    bridge.updateModelContext(outcome.context, stateKey);
  };
  footer.run(confirmButton, () => press('confirm'));
  footer.run(cancelButton, () => press('cancel'));
}

const bridge = new WidgetBridge('renkei-issue-preview');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
