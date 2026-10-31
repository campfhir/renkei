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
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  doneStateOf,
  el,
  htmlField,
  injectStyle,
  inputField,
  readonlyField,
  parseLinks,
  recallDone,
  rememberDone,
  renderDone,
  str,
  strings,
  textField,
  type DoneState,
} from './ui';
import { planSend, sendLabel, suggestedSendFields } from './email-compose.model';

const KIND_TITLES: Record<string, string> = {
  compose: 'New email',
  reply: 'Reply',
  replyAll: 'Reply all',
  forward: 'Forward',
};

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const draft =
    typeof result.structuredContent === 'object' && result.structuredContent !== null
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (result.structuredContent as Record<string, unknown>)
      : {};
  const draftId = str(draft.draftId);
  const kind = str(draft.kind) || 'compose';

  const card = el('div', 'card');
  if (result.isError || !draftId) {
    card.append(
      el('div', 'card-title', 'Email preview'),
      el('div', 'status error', resultText(result) || 'The draft could not be created.')
    );
    root.append(card);
    return;
  }

  const stateKey = `renkei-email:${draftId}`;
  const remembered = doneStateOf(draft.resolved) ?? recallDone(stateKey);
  if (remembered) {
    renderDone(root, remembered);
    return;
  }
  const finishDone = (state: DoneState) => {
    rememberDone(stateKey, state);
    bridge.reportDecision(stateKey, state);
    renderDone(root, state);
  };

  card.append(
    el('div', 'card-title', KIND_TITLES[kind] ?? 'Email'),
    el('div', 'card-subtitle', 'Review before it goes out — nothing is sent until you confirm.')
  );

  const compose = kind === 'compose';
  // A reply's own text is rebuilt around the quoted thread from the message
  // it answers; a card from before previews carried that id keeps its text
  // read-only (its recipients and subject are still a plain PATCH).
  const messageId = str(draft.messageId);
  const commentEditable = !compose && messageId !== '';
  const to = strings(draft.to).join(', ');
  const cc = strings(draft.cc).join(', ');
  const bcc = strings(draft.bcc).join(', ');
  const subject = str(draft.subject);
  const body = str(draft.body);
  const bodyHtml = str(draft.bodyHtml);

  const toInput = inputField('To', to);
  const ccInput = cc ? inputField('Cc', cc) : null;
  const subjectInput = inputField('Subject', subject);
  const bodyInput = compose
    ? textField('Body', body)
    : commentEditable
      ? textField(kind === 'forward' ? 'Note' : 'Body', body)
      : null;

  card.append(toInput.field);
  if (ccInput) card.append(ccInput.field);
  if (bcc) card.append(readonlyField('Bcc', bcc));
  card.append(subjectInput.field);
  if (bodyInput) {
    card.append(bodyInput.field);
    card.append(
      el('div', 'card-subtitle', 'Markdown: **bold**, *italic*, "- " bullets, "1. " numbered.')
    );
  } else {
    card.append(bodyHtml ? htmlField('Body', bodyHtml) : readonlyField('Body', body));
  }
  if (kind !== 'compose') {
    card.append(
      el('div', 'card-subtitle', 'The quoted thread below your text is included on send.')
    );
  }

  // A time the model picked arrives as a UTC instant; the picker works in the
  // viewer's local clock, so it is shown there. A time that has already
  // passed is left off rather than pre-filled into a refusal.
  const suggested = suggestedSendFields(str(draft.sendAt), Date.now());
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
      { draftId, kind, messageId, to, cc, subject, body },
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
    const { when } = plan;
    const finalSubject = plan.subject;
    const sent = await bridge.callTool('outlook_send_draft_confirm', plan.args, stateKey);
    if (sent.isError) {
      throw new Error(resultText(sent) || (when ? 'Scheduling failed' : 'Send failed'));
    }
    const sentTo = plan.to.join(', ');
    const what = `To ${sentTo}${finalSubject ? ` — “${finalSubject}”` : ''}`;
    finishDone({
      icon: 'sent',
      ...(parseLinks(resultText(sent)).length > 0 ? { links: parseLinks(resultText(sent)) } : {}),
      headline: when ? 'Scheduled' : 'Sent',
      detail: when ? `${what} — sends ${when.toLocaleString()}` : what,
    });
    bridge.updateModelContext(
      when
        ? `The user reviewed the ${KIND_TITLES[kind] ?? 'email'} preview and scheduled it to ${sentTo} for ${when.toISOString()}.`
        : `The user reviewed the ${KIND_TITLES[kind] ?? 'email'} preview and sent it to ${sentTo}.`,
      stateKey
    );
  });

  footer.run(discardButton, async () => {
    const discarded = await bridge.callTool('outlook_discard_draft_confirm', { draftId }, stateKey);
    if (discarded.isError) throw new Error(resultText(discarded) || 'Discard failed');
    finishDone({ icon: 'cancelled', headline: 'Discarded', detail: 'Nothing was sent.' });
    bridge.updateModelContext(
      'The user discarded the email draft from the preview card. Nothing was sent.',
      stateKey
    );
  });
}

const bridge = new WidgetBridge('renkei-email-compose');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
