/**
 * Chat message preview card (WebEx).
 *
 * Unlike email there is no server-side draft to point at — WebEx has no
 * draft concept — so the preview tool only resolved the destination (room
 * title, or the 1:1 recipient) and the card holds the message itself. Send
 * posts it through the app-only webex_send_message_confirm with whatever the
 * text says at that moment; Cancel sends nothing and nothing needs cleanup.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  el,
  injectStyle,
  readonlyField,
  parseLinks,
  recallDone,
  rememberDone,
  renderDone,
  str,
  textField,
  type DoneState,
} from './ui';

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const preview =
    typeof result.structuredContent === 'object' && result.structuredContent !== null
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (result.structuredContent as Record<string, unknown>)
      : {};
  const roomId = str(preview.roomId);
  const toPersonEmail = str(preview.toPersonEmail);

  const card = el('div', 'card');
  if (result.isError || (!roomId && !toPersonEmail)) {
    card.append(
      el('div', 'card-title', 'WebEx message'),
      el('div', 'status error', resultText(result) || 'The message could not be prepared.')
    );
    root.append(card);
    return;
  }

  const destination = roomId ? str(preview.roomTitle) || `room ${roomId}` : toPersonEmail;
  // Keyed by the id the preview tool minted for THIS card, not by its
  // content: two previews of the same kind used to share a receipt, so the
  // second rendered as already-decided with no fields and no button. No id
  // means an older server — render the live card rather than risk showing
  // someone else's outcome.
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

  card.append(
    el('div', 'card-title', 'WebEx message'),
    el('div', 'card-subtitle', 'Posts as you — nothing is sent until you confirm.'),
    readonlyField('To', destination)
  );
  if (str(preview.parentId)) {
    card.append(el('div', 'card-subtitle', 'Sent as a threaded reply.'));
  }
  const message = textField('Message (WebEx markdown)', str(preview.markdown));
  card.append(message.field);

  const cancelButton = el('button', undefined, 'Cancel');
  const sendButton = el('button', 'primary', 'Send');
  const footer = cardActions([cancelButton, sendButton]);
  card.append(footer.actions);
  root.append(card);

  footer.run(sendButton, async () => {
    const markdown = message.input.value.trim();
    if (!markdown) throw new Error('The message is empty.');
    const sent = await bridge.callTool('webex_send_message_confirm', {
      ...(roomId ? { roomId } : { toPersonEmail }),
      markdown,
      ...(str(preview.parentId) ? { parentId: str(preview.parentId) } : {}),
    });
    if (sent.isError) throw new Error(resultText(sent) || 'Send failed');
    const sentLinks = parseLinks(resultText(sent));
    finishDone({
      icon: 'sent',
      headline: 'Sent',
      detail: `To ${destination}`,
      ...(sentLinks.length > 0 ? { links: sentLinks } : {}),
    });
    bridge.updateModelContext(
      `The user reviewed the WebEx message preview and sent it to ${destination}.`
    );
  });

  footer.run(cancelButton, async () => {
    finishDone({ icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing was sent.' });
    bridge.updateModelContext(
      'The user cancelled the WebEx message from the preview card. Nothing was sent.'
    );
  });
}

const bridge = new WidgetBridge('renkei-chat-message');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
