/**
 * The act-preview card: the preview every act tool draws in chat
 * (lib/mcp-tools/previews/). This file is the shell — the headline and verb,
 * the receipt once decided, editing what the person may rewrite, the
 * confirm and cancel buttons — and act-render.ts holds the layout for each
 * kind of act. act-card.ts is the contract between them and the tools.
 *
 *   { kind: 'act', previewId, verb, tone, icon, title, subtitle?,
 *     confirmLabel?, editable?, body: { kind: 'comment' | 'transition' | … },
 *     confirmTool, confirmArgs }
 *
 * Confirm calls `confirmTool` with `confirmArgs`, with the arguments the
 * person edited on the card written over the ones the model proposed;
 * Cancel runs nothing. Either way the card collapses to a receipt, kept
 * across devices by the host (bridge.reportDecision) and in this browser
 * (rememberDone) so it can never offer a live button for a decided act.
 */

import type { ActCard, Editable } from './act-card';
import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  icon,
  injectActStyle,
  readOnlyWords,
  renderBody,
  toneClass,
  type RenderContext,
} from './act-render';
import {
  cardActions,
  doneStateOf,
  el,
  injectStyle,
  parseLinks,
  recallDone,
  rememberDone,
  renderDone,
  str,
  type DoneState,
} from './ui';

function asRecord(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The card, if this is one; a result from an older server or an error is not. */
function readCard(value: unknown): ActCard | null {
  const record = asRecord(value);
  if (record.kind !== 'act') return null;
  const body = asRecord(record.body);
  if (typeof body.kind !== 'string' || typeof record.confirmTool !== 'string') return null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return record as unknown as ActCard;
}

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';
  const preview = asRecord(result.structuredContent);
  const card = readCard(result.structuredContent);

  const shell = el('div', 'card');
  if (result.isError || !card) {
    shell.append(
      el('div', 'card-title', str(preview.title) || 'Action'),
      el('div', 'status error', resultText(result) || 'The preview could not be prepared.')
    );
    root.append(shell);
    return;
  }

  // Keyed by the id minted for THIS card (issue-preview.ts explains why not
  // by content): a second preview of the same act must not recall the first
  // one's receipt.
  const stateKey = card.previewId ? `renkei-preview:${card.previewId}` : '';
  const remembered = doneStateOf(preview.resolved) ?? (stateKey ? recallDone(stateKey) : null);
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

  const editable: Editable[] = Array.isArray(card.editable) ? card.editable : [];
  const readers = new Map<string, () => string>();
  const context: RenderContext = {
    words(key, text, label) {
      if (text === undefined && !key) return null;
      const value = text ?? '';
      const spec = key ? editable.find((entry) => entry.key === key) : undefined;
      if (!key || !spec) return value ? readOnlyWords(value) : null;
      const input =
        spec.multiline === false ? el('input', 'a-words-edit') : el('textarea', 'a-words-edit');
      input.value = value;
      input.setAttribute('aria-label', spec.label || label || key);
      readers.set(key, () => input.value);
      return input;
    },
  };

  const tone = toneClass(card.tone);
  const head = el('div', `a-head ${tone}`);
  const tile = el('span', 'a-tile');
  tile.append(icon(card.icon));
  const text = el('div', 'a-head-text');
  text.append(el('div', 'card-title', str(card.title)));
  if (str(card.subtitle)) text.append(el('div', 'card-subtitle', str(card.subtitle)));
  head.append(tile, text, el('span', 'a-verb', str(card.verb)));
  shell.append(head, el('div', 'card-subtitle', 'Review — nothing happens until you confirm.'));

  const body = renderBody(card.body, context);
  if (body) {
    body.classList.add(tone);
    shell.append(body);
  }

  const cancelButton = el('button', undefined, 'Cancel');
  const confirmButton = el(
    'button',
    'primary',
    str(card.confirmLabel) || str(card.verb) || 'Confirm'
  );
  if (card.tone === 'danger') confirmButton.classList.add('is-danger');
  const footer = cardActions([cancelButton, confirmButton]);
  shell.append(footer.actions);
  root.append(shell);

  const original = asRecord(card.confirmArgs);
  const gatherArgs = (): Record<string, unknown> => {
    const args: Record<string, unknown> = { ...original };
    for (const [key, read] of readers) {
      const value = read().trim();
      // An emptied box means "leave it as the model proposed", never "send
      // an empty required argument".
      if (value) args[key] = value;
      else if (original[key] === undefined) delete args[key];
    }
    return args;
  };

  footer.run(confirmButton, async () => {
    const confirmed = await bridge.callTool(card.confirmTool, gatherArgs(), stateKey);
    const reply = resultText(confirmed);
    if (confirmed.isError) throw new Error(reply || 'The action failed');
    const links = parseLinks(reply);
    finishDone({
      icon: 'sent',
      headline: reply.split('\n')[0] || 'Done',
      detail: str(card.title),
      ...(links.length > 0 ? { links } : {}),
    });
    bridge.updateModelContext(
      `The user confirmed "${str(card.title)}" on the preview card. Result: ${reply}`,
      stateKey
    );
  });

  footer.run(cancelButton, async () => {
    finishDone({ icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing changed.' });
    bridge.updateModelContext(
      `The user cancelled "${str(card.title)}" from the preview card. Nothing changed.`,
      stateKey
    );
  });
}

const bridge = new WidgetBridge('renkei-act-preview');
injectStyle();
injectActStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
