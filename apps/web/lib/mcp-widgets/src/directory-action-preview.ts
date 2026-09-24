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
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  avatar,
  cardActions,
  el,
  injectStyle,
  parseLinks,
  recallDone,
  rememberDone,
  renderDone,
  str,
  strings,
  type DoneState,
} from './ui';

interface FieldRow {
  label: string;
  value: string;
  oldValue?: string;
}

interface GroupList {
  label: string;
  groups: string[];
  tone?: 'add' | 'remove' | 'muted';
}

const TONE_CLASS: Record<string, string> = {
  positive: 'done',
  caution: 'warn',
  neutral: 'progress',
};

const GROUP_TONE_CLASS: Record<string, string> = {
  add: 'done',
  remove: 'urgent',
  muted: 'neutral',
};

function asRecord(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

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
  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      label: str(record.label),
      groups: strings(record.groups),
      ...(record.tone === 'add' || record.tone === 'remove' || record.tone === 'muted'
        ? { tone: record.tone }
        : {}),
    };
  });
}

function personRow(name: string, detail: string, sub?: HTMLElement): HTMLElement {
  const row = el('div', 'person');
  const text = el('div');
  text.append(el('div', 'person-name', name));
  if (detail) text.append(el('div', 'person-detail', detail));
  if (sub) text.append(sub);
  row.append(avatar(name || '?', 'lg'), text);
  return row;
}

function chipRow(groups: string[], tone: 'add' | 'remove' | 'muted' = 'muted'): HTMLElement {
  const row = el('div', 'chip-row');
  const chipClass = GROUP_TONE_CLASS[tone];
  for (const group of groups) row.append(el('span', `chip ${chipClass}`, group));
  return row;
}

/** Best-effort clipboard copy — a sandboxed iframe may deny it outright. */
function copyButton(value: string): HTMLButtonElement {
  const button = el('button', 'link', 'Copy');
  button.type = 'button';
  const reset = () => {
    button.textContent = 'Copy';
  };
  button.addEventListener('click', () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      button.textContent = 'Select to copy';
      setTimeout(reset, 1500);
      return;
    }
    clipboard.writeText(value).then(
      () => {
        button.textContent = 'Copied';
        setTimeout(reset, 1500);
      },
      () => {
        button.textContent = 'Select to copy';
        setTimeout(reset, 1500);
      }
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

  const preview = asRecord(result.structuredContent);
  const confirmTool = str(preview.confirmTool);
  const confirmArgs = asRecord(preview.confirmArgs);

  const card = el('div', 'card');
  if (result.isError || !confirmTool) {
    card.append(
      el('div', 'card-title', str(preview.title) || 'Directory action'),
      el('div', 'status error', resultText(result) || 'The preview could not be prepared.')
    );
    root.append(card);
    return;
  }

  // Keyed by the id the preview tool minted for THIS card — see
  // issue-preview.ts's identical comment for why: content-based keys let a
  // second preview of the same kind recall the first one's receipt.
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

  const titleRow = el('div', 'title-row');
  titleRow.append(el('div', 'card-title', str(preview.title)));
  const action = str(preview.action);
  if (action) {
    const toneClass = TONE_CLASS[str(preview.tone)] ?? 'neutral';
    titleRow.append(el('span', `chip ${toneClass}`, action));
  }
  card.append(titleRow);
  if (str(preview.subtitle)) card.append(el('div', 'card-subtitle', str(preview.subtitle)));
  card.append(el('div', 'card-subtitle', 'Review — nothing changes until you confirm.'));

  const person = asRecord(preview.person);
  if (str(person.name)) card.append(personRow(str(person.name), str(person.detail)));

  const secondaryPerson = asRecord(preview.secondaryPerson);
  if (str(secondaryPerson.name)) {
    const label = str(secondaryPerson.label) || 'Also involved';
    card.append(
      personRow(
        str(secondaryPerson.name),
        str(secondaryPerson.detail),
        el('div', 'person-detail', label)
      )
    );
  }

  for (const row of fieldRows(preview.fields)) {
    const field = el('div', 'field');
    field.append(el('div', 'field-label', row.label), el('div', 'field-value', row.value));
    if (row.oldValue) field.append(el('div', 'card-subtitle', `was: ${row.oldValue}`));
    card.append(field);
  }

  const secret = asRecord(preview.secret);
  if (str(secret.value)) {
    card.append(secretField(str(secret.label) || 'Password', str(secret.value), str(secret.note)));
  }

  for (const list of groupLists(preview.groupLists)) {
    if (list.groups.length === 0) continue;
    const field = el('div', 'field');
    const label = el('div', 'field-label');
    label.append(
      document.createTextNode(list.label),
      el('span', 'group-count', ` (${list.groups.length})`)
    );
    // Capped and scrollable (ui.ts's .chip-row), not just wrapping: a
    // technician copying membership from a long-tenured account can be
    // looking at dozens or hundreds of groups, and an unbounded pill grid
    // would either blow the card past a reviewable height or, worse,
    // silently truncate the list the confirm button is about to act on.
    field.append(label, chipRow(list.groups, list.tone));
    card.append(field);
  }

  const cancelButton = el('button', undefined, 'Cancel');
  const confirmButton = el('button', 'primary', str(preview.confirmLabel) || 'Confirm');
  const footer = cardActions([cancelButton, confirmButton]);
  card.append(footer.actions);
  root.append(card);

  footer.run(confirmButton, async () => {
    const confirmed = await bridge.callTool(confirmTool, confirmArgs);
    const text = resultText(confirmed);
    if (confirmed.isError) throw new Error(text || 'The action failed');
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
    finishDone({ icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing changed.' });
    bridge.updateModelContext(
      `The user cancelled "${str(preview.title)}" from the preview card. Nothing changed.`
    );
  });
}

const bridge = new WidgetBridge('renkei-directory-action-preview');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
