/**
 * Directory action preview card (ADManager Plus — unlock, reset password,
 * create/edit a user, security-group membership).
 *
 * Purpose-built rather than reusing `issue-preview`'s generic work-item
 * shape: these are identity/access actions against a real employee's AD
 * account, not a ticket. What a Jira card needs (a summary line, a
 * description) is not what a technician needs here — who the account
 * belongs to, front and center, and two things no generic card renders at
 * all: a generated password (shown plainly with a Copy button — the whole
 * point is relaying it to the account holder, not hiding it from the
 * technician who requested it) and group membership as a list of names,
 * not a diff of two opaque strings.
 *
 *   { kind: 'directory_action', previewId,
 *     action, tone: 'positive' | 'caution' | 'neutral',  // the action chip
 *     title, subtitle?,
 *     person: { name, detail? },                 // whose account this is
 *     secondaryPerson?: { label, name, detail? }, // copy-group-membership's source
 *     fields?: [{ label, value, oldValue? }],     // attributes / status / flags
 *     secret?: { label, value, note? },           // a password to relay
 *     groupLists?: [{ label, groups, tone? }],    // 'add' | 'remove' | 'muted'
 *     confirmTool, confirmLabel, confirmArgs }    // passed through verbatim
 *
 * Every field here is read-only on the card — the technician chose these
 * values (or reviewed a generated password) before the preview ever
 * rendered; there is nothing to edit in place, only to confirm or cancel.
 *
 * What the card shows, what Confirm sends and what each decision leaves
 * behind are decided in directory-action-preview.model.ts (tested beside
 * it); this file draws that and makes the calls.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  avatar,
  cardActions,
  el,
  injectStyle,
  recallDone,
  rememberDone,
  renderDone,
  type DoneState,
} from './ui';
import {
  COPY_FEEDBACK_MS,
  REVIEW_NOTE,
  cancelOutcome,
  confirmCall,
  confirmOutcome,
  copyLabel,
  copyReducer,
  openingReceipt,
  readPreview,
  type CopyAction,
  type CopyState,
  type GroupList,
} from './directory-action-preview.model';

function personRow(name: string, detail: string, sub?: HTMLElement): HTMLElement {
  const row = el('div', 'person');
  const text = el('div');
  text.append(el('div', 'person-name', name));
  if (detail) text.append(el('div', 'person-detail', detail));
  if (sub) text.append(sub);
  row.append(avatar(name || '?', 'lg'), text);
  return row;
}

function chipRow(list: GroupList): HTMLElement {
  const row = el('div', 'chip-row');
  for (const group of list.groups) row.append(el('span', `chip ${list.chipClass}`, group));
  return row;
}

/** Best-effort clipboard copy — a sandboxed iframe may deny it outright. */
function copyButton(value: string): HTMLButtonElement {
  let state: CopyState = 'idle';
  const button = el('button', 'link', copyLabel(state));
  button.type = 'button';
  const dispatch = (action: CopyAction) => {
    state = copyReducer(state, action);
    button.textContent = copyLabel(state);
    if (action.type !== 'reset') setTimeout(() => dispatch({ type: 'reset' }), COPY_FEEDBACK_MS);
  };
  button.addEventListener('click', () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      dispatch({ type: 'refused' });
      return;
    }
    clipboard.writeText(value).then(
      () => dispatch({ type: 'copied' }),
      () => dispatch({ type: 'refused' })
    );
  });
  return button;
}

function secretField(label: string, value: string, note?: string): HTMLElement {
  const field = el('div', 'field');
  const row = el('div', 'secret-row');
  row.append(el('div', 'field-value', value), copyButton(value));
  field.append(el('div', 'field-label', label), row);
  if (note) field.append(el('div', 'card-subtitle', note));
  return field;
}

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const preview = readPreview(
    result.structuredContent,
    Boolean(result.isError),
    resultText(result)
  );
  const card = el('div', 'card');
  if (!preview.ok) {
    card.append(el('div', 'card-title', preview.title), el('div', 'status error', preview.error));
    root.append(card);
    return;
  }

  const { stateKey } = preview;
  const remembered = openingReceipt(
    result.structuredContent,
    stateKey ? recallDone(stateKey) : null
  );
  if (remembered) {
    renderDone(root, remembered);
    return;
  }
  const finishDone = (state: DoneState) => {
    if (stateKey) {
      rememberDone(stateKey, state);
      bridge.reportDecision(stateKey, state);
    }
    renderDone(root, state);
  };

  const titleRow = el('div', 'title-row');
  titleRow.append(el('div', 'card-title', preview.title));
  if (preview.action) {
    titleRow.append(el('span', `chip ${preview.action.chipClass}`, preview.action.label));
  }
  card.append(titleRow);
  if (preview.subtitle) card.append(el('div', 'card-subtitle', preview.subtitle));
  card.append(el('div', 'card-subtitle', REVIEW_NOTE));

  if (preview.person) card.append(personRow(preview.person.name, preview.person.detail));

  const secondary = preview.secondaryPerson;
  if (secondary) {
    card.append(
      personRow(secondary.name, secondary.detail, el('div', 'person-detail', secondary.label))
    );
  }

  for (const row of preview.fields) {
    const field = el('div', 'field');
    field.append(el('div', 'field-label', row.label), el('div', 'field-value', row.value));
    if (row.oldValue) field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
    card.append(field);
  }

  if (preview.secret) {
    card.append(secretField(preview.secret.label, preview.secret.value, preview.secret.note));
  }

  for (const list of preview.groupLists) {
    const field = el('div', 'field');
    const label = el('div', 'field-label');
    label.append(document.createTextNode(list.label), el('span', 'group-count', list.count));
    // Capped and scrollable (ui.ts's .chip-row), not just wrapping: a
    // technician copying membership from a long-tenured account can be
    // looking at dozens or hundreds of groups, and an unbounded pill grid
    // would either blow the card past a reviewable height or, worse,
    // silently truncate the list the confirm button is about to act on.
    field.append(label, chipRow(list));
    card.append(field);
  }

  const cancelButton = el('button', undefined, 'Cancel');
  const confirmButton = el('button', 'primary', preview.confirmLabel);
  const footer = cardActions([cancelButton, confirmButton]);
  card.append(footer.actions);
  root.append(card);

  footer.run(confirmButton, async () => {
    const call = confirmCall(preview);
    const confirmed = await bridge.callTool(call.name, call.args, stateKey);
    const outcome = confirmOutcome(preview, {
      isError: Boolean(confirmed.isError),
      text: resultText(confirmed),
    });
    if (!outcome.ok) throw new Error(outcome.error);
    finishDone(outcome.done);
    bridge.updateModelContext(outcome.context, stateKey);
  });

  footer.run(cancelButton, async () => {
    const outcome = cancelOutcome(preview);
    finishDone(outcome.done);
    bridge.updateModelContext(outcome.context, stateKey);
  });
}

const bridge = new WidgetBridge('renkei-directory-action-preview');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
