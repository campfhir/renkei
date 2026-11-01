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
 *
 * What the card decides — which words are a box, what the twin is sent,
 * the receipt and the model's line — is act-preview.model.ts's, tested in
 * act-preview.model.test.ts; this file draws it and makes the calls.
 */

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
  cancelDecision,
  confirmArgs,
  confirmLabel,
  confirmOutcome,
  decisionKey,
  editableFields,
  readCard,
  unpreparedCard,
  wordsView,
} from './act-preview.model';
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
import { asRecord } from '@renkei/guards';

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';
  const preview = asRecord(result.structuredContent);
  const card = readCard(result.structuredContent);

  const shell = el('div', 'card');
  if (result.isError || !card) {
    const unprepared = unpreparedCard(result.structuredContent, resultText(result));
    shell.append(
      el('div', 'card-title', unprepared.title),
      el('div', 'status error', unprepared.error)
    );
    root.append(shell);
    return;
  }

  // Keyed by the id minted for THIS card (issue-preview.ts explains why not
  // by content): a second preview of the same act must not recall the first
  // one's receipt.
  const stateKey = decisionKey(card);
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

  const editable = editableFields(card);
  const readers = new Map<string, () => string>();
  const context: RenderContext = {
    words(key, text, label) {
      const view = wordsView(editable, key, text, label);
      if (view.kind === 'none') return null;
      if (view.kind === 'read') return readOnlyWords(view.text);
      const input = view.singleLine ? el('input', 'a-words-edit') : el('textarea', 'a-words-edit');
      input.value = view.value;
      input.setAttribute('aria-label', view.label);
      readers.set(view.key, () => input.value);
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
  const confirmButton = el('button', 'primary', confirmLabel(card));
  if (card.tone === 'danger') confirmButton.classList.add('is-danger');
  const footer = cardActions([cancelButton, confirmButton]);
  shell.append(footer.actions);
  root.append(shell);

  footer.run(confirmButton, async () => {
    const edits = new Map([...readers].map(([key, read]) => [key, read()]));
    const confirmed = await bridge.callTool(card.confirmTool, confirmArgs(card, edits), stateKey);
    const reply = resultText(confirmed);
    const outcome = confirmOutcome(card, {
      isError: confirmed.isError,
      text: reply,
      links: parseLinks(reply),
    });
    if (!outcome.ok) throw new Error(outcome.error);
    finishDone(outcome.done);
    bridge.updateModelContext(outcome.modelContext, stateKey);
  });

  footer.run(cancelButton, async () => {
    const decision = cancelDecision(card);
    finishDone(decision.done);
    bridge.updateModelContext(decision.modelContext, stateKey);
  });
}

const bridge = new WidgetBridge('renkei-act-preview');
injectStyle();
injectActStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
