/**
 * Email preview card.
 *
 * Rendered by the outlook_*_preview tools: their handler has already created
 * a real Graph draft, and this card shows exactly that draft. Send runs the
 * app-only outlook_send_draft_confirm; Discard runs
 * outlook_discard_draft_confirm and deletes the draft. Every card is
 * editable — edits ride to the confirm tool as overrides and are PATCHed
 * onto the draft before it goes out. A reply/reply-all/forward's own text
 * is the exception to PATCHing: Graph's draft body is that text and the
 * quoted thread as one, so an edited comment goes to the confirm tool with
 * the message it answers (`messageId`) and the draft is rebuilt from it.
 *
 * "Send later" picks a moment and turns Send into Schedule: the confirm tool
 * gets a `sendAt` and Exchange holds the message in the Outbox until then.
 *
 * Bodies are Markdown. The editable textarea holds the Markdown source
 * (what the confirm tool renders on send); a read-only body shows the
 * server's rendering of it, so the user sees the email as it will arrive.
 *
 * What the card shows, which fields are editable, what Send and Discard
 * call and what each answer leaves are decided in email-compose.model.ts
 * (tested beside it); this file draws that, reads the fields and the
 * clock, and makes the calls.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  el,
  htmlField,
  injectStyle,
  inputField,
  readonlyField,
  recallDone,
  rememberDone,
  renderDone,
  textField,
  type DoneState,
} from './ui';
import {
  discardCall,
  discardOutcome,
  emailLayout,
  openingReceipt,
  planSend,
  readDraft,
  sendLabel,
  sendOutcome,
  suggestedSendFields,
} from './email-compose.model';

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const read = readDraft(result.structuredContent, Boolean(result.isError), resultText(result));
  const card = el('div', 'card');
  if (!read.ok) {
    card.append(el('div', 'card-title', 'Email preview'), el('div', 'status error', read.error));
    root.append(card);
    return;
  }
  const { draft } = read;
  const { stateKey } = draft;

  const remembered = openingReceipt(draft, recallDone(stateKey));
  if (remembered) {
    renderDone(root, remembered);
    return;
  }
  const finishDone = (state: DoneState) => {
    rememberDone(stateKey, state);
    bridge.reportDecision(stateKey, state);
    renderDone(root, state);
  };

  const layout = emailLayout(draft);
  card.append(
    el('div', 'card-title', layout.title),
    el('div', 'card-subtitle', 'Review before it goes out — nothing is sent until you confirm.')
  );

  const toInput = inputField('To', draft.to);
  const ccInput = layout.ccEditable ? inputField('Cc', draft.cc) : null;
  const subjectInput = inputField('Subject', draft.subject);
  const bodyInput = layout.textLabel ? textField(layout.textLabel, draft.body) : null;

  card.append(toInput.field);
  if (ccInput) card.append(ccInput.field);
  if (layout.bcc) card.append(readonlyField('Bcc', layout.bcc));
  card.append(subjectInput.field);
  if (bodyInput) {
    card.append(bodyInput.field);
    card.append(
      el('div', 'card-subtitle', 'Markdown: **bold**, *italic*, "- " bullets, "1. " numbered.')
    );
  } else if (layout.readonlyBody) {
    card.append(
      'html' in layout.readonlyBody
        ? htmlField('Body', layout.readonlyBody.html)
        : readonlyField('Body', layout.readonlyBody.text)
    );
  }
  if (layout.quotedThreadNote) {
    card.append(
      el('div', 'card-subtitle', 'The quoted thread below your text is included on send.')
    );
  }

  // A time the model picked arrives as a UTC instant; the picker works in the
  // viewer's local clock, so it is shown there. A time that has already
  // passed is left off rather than pre-filled into a refusal.
  const suggested = suggestedSendFields(draft.sendAt, Date.now());
  // Date and time are two inputs: a native date-time control is wider than a
  // phone column and is hard to fill by hand, while each half is a plain field.
  const sendDate = inputField('Send date (optional)', suggested?.day ?? '');
  sendDate.input.type = 'date';
  const sendTime = inputField('Time', suggested?.clock ?? '');
  sendTime.input.type = 'time';
  const sendLaterRow = el('div', 'field-row');
  sendLaterRow.append(sendDate.field, sendTime.field);
  card.append(sendLaterRow);
  const discardButton = el('button', undefined, 'Discard');
  const sendButton = el(
    'button',
    'primary',
    sendLabel(suggested?.day ?? '', suggested?.clock ?? '')
  );
  const footer = cardActions([discardButton, sendButton]);
  card.append(footer.actions);
  root.append(card);
  const syncSendButton = () => {
    sendButton.textContent = sendLabel(sendDate.input.value, sendTime.input.value);
  };
  sendDate.input.addEventListener('input', syncSendButton);
  sendTime.input.addEventListener('input', syncSendButton);

  footer.run(sendButton, async () => {
    const plan = planSend(
      draft,
      {
        to: toInput.input.value,
        cc: ccInput ? ccInput.input.value : null,
        subject: subjectInput.input.value,
        body: bodyInput ? bodyInput.input.value : null,
        day: sendDate.input.value,
        clock: sendTime.input.value,
      },
      Date.now()
    );
    if (!plan.ok) throw new Error(plan.error);
    const sent = await bridge.callTool('outlook_send_draft_confirm', plan.args, stateKey);
    const outcome = sendOutcome(draft.kind, plan, {
      isError: Boolean(sent.isError),
      text: resultText(sent),
    });
    if (!outcome.ok) throw new Error(outcome.error);
    finishDone(outcome.done);
    bridge.updateModelContext(outcome.context, stateKey);
  });

  footer.run(discardButton, async () => {
    const call = discardCall(draft);
    const discarded = await bridge.callTool(call.name, call.args, stateKey);
    const outcome = discardOutcome({
      isError: Boolean(discarded.isError),
      text: resultText(discarded),
    });
    if (!outcome.ok) throw new Error(outcome.error);
    finishDone(outcome.done);
    bridge.updateModelContext(outcome.context, stateKey);
  });
}

const bridge = new WidgetBridge('renkei-email-compose');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
