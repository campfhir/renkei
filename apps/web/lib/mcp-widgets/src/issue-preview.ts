/**
 * Work-item preview card (Jira issues, JSM requests).
 *
 * Deliberately generic where the email card is specific: issue-shaped writes
 * differ only in their field list and which confirm tool they run, so the
 * preview tool ships the whole contract in structuredContent —
 *
 *   { kind: 'issue', title, subtitle?, confirmTool, confirmLabel,
 *     confirmArgs,                    // passed through verbatim on confirm
 *     editable?: { summaryKey?, descriptionKey? },   // keys into confirmArgs
 *     fields: [{ label, value, oldValue? }] }        // display rows
 *
 * — and this one card serves create, update, and JSM request alike. An
 * update's rows carry oldValue so the user sees what changes, not just the
 * end state. Only summary/description are editable on the card; anything
 * structural (project, type, priority) goes back through the model, which
 * can resolve it properly.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  el,
  injectStyle,
  inputField,
  parseLinks,
  recallDone,
  rememberDone,
  renderDone,
  str,
  textField,
  type DoneState,
} from './ui';

interface FieldRow {
  label: string;
  value: string;
  oldValue?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
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
        return {
          label: str(record.label),
          value: str(record.value),
          ...(str(record.oldValue) ? { oldValue: str(record.oldValue) } : {}),
        };
      })
    : [];
  for (const row of rows) {
    const field = el('div', 'field');
    field.append(el('div', 'field-label', row.label));
    const value = el('div', 'field-value', row.value);
    field.append(value);
    if (row.oldValue) field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
    card.append(field);
  }

  const descriptionInput = descriptionKey
    ? textField('Description (markdown)', str(confirmArgs[descriptionKey]))
    : null;
  if (descriptionInput) card.append(descriptionInput.field);

  const cancelButton = el('button', undefined, 'Cancel');
  const confirmButton = el('button', 'primary', str(preview.confirmLabel) || 'Confirm');
  const footer = cardActions([cancelButton, confirmButton]);
  card.append(footer.actions);
  root.append(card);

  footer.run(confirmButton, async () => {
    const args = { ...confirmArgs };
    if (summaryInput && summaryKey) {
      args[summaryKey] = summaryInput.input.value.trim() || str(confirmArgs[summaryKey]);
    }
    if (descriptionInput && descriptionKey) {
      const value = descriptionInput.input.value.trim();
      if (value) args[descriptionKey] = value;
      else delete args[descriptionKey];
    }
    const confirmed = await bridge.callTool(confirmTool, args);
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
    finishDone({ icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing was written.' });
    bridge.updateModelContext(
      `The user cancelled "${str(preview.title)}" from the preview card. Nothing was written.`
    );
  });
}

const bridge = new WidgetBridge('renkei-issue-preview');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
