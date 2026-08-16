/**
 * Email preview card.
 *
 * Rendered by the outlook_*_preview tools: their handler has already created
 * a real Graph draft, and this card shows exactly that draft. Send runs the
 * app-only outlook_send_draft_confirm; Discard runs
 * outlook_discard_draft_confirm and deletes the draft. A fresh compose
 * (kind 'compose') is editable — edits ride to the confirm tool as overrides
 * and are PATCHed onto the draft before it goes out. Reply/reply-all/forward
 * drafts are shown read-only: Graph's draft body carries the quoted thread,
 * and a body edit would replace the whole thing, quotes included.
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  el,
  injectStyle,
  inputField,
  readonlyField,
  recallDone,
  rememberDone,
  renderDone,
  splitAddresses,
  str,
  strings,
  textField,
  type DoneState,
} from './ui';

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
  const remembered = recallDone(stateKey);
  if (remembered) {
    renderDone(root, remembered);
    return;
  }
  const finishDone = (state: DoneState) => {
    rememberDone(stateKey, state);
    renderDone(root, state);
  };

  card.append(
    el('div', 'card-title', KIND_TITLES[kind] ?? 'Email'),
    el('div', 'card-subtitle', 'Review before it goes out — nothing is sent until you confirm.')
  );

  const editable = kind === 'compose';
  const to = strings(draft.to).join(', ');
  const cc = strings(draft.cc).join(', ');
  const bcc = strings(draft.bcc).join(', ');
  const subject = str(draft.subject);
  const body = str(draft.body);

  const toInput = editable ? inputField('To', to) : null;
  const ccInput = editable && cc ? inputField('Cc', cc) : null;
  const subjectInput = editable ? inputField('Subject', subject) : null;
  const bodyInput = editable ? textField('Body', body) : null;

  if (toInput) card.append(toInput.field);
  else card.append(readonlyField('To', to || '(auto-populated by reply)'));
  if (ccInput) card.append(ccInput.field);
  else if (cc) card.append(readonlyField('Cc', cc));
  if (bcc) card.append(readonlyField('Bcc', bcc));
  if (subjectInput) card.append(subjectInput.field);
  else card.append(readonlyField('Subject', subject));
  if (bodyInput) card.append(bodyInput.field);
  else {
    card.append(readonlyField('Body', body));
    if (kind !== 'compose') {
      card.append(
        el('div', 'card-subtitle', 'The quoted thread below your text is included on send.')
      );
    }
  }

  const discardButton = el('button', undefined, 'Discard');
  const sendButton = el('button', 'primary', 'Send');
  const footer = cardActions([discardButton, sendButton]);
  card.append(footer.actions);
  root.append(card);

  footer.run(sendButton, async () => {
    const overrides = editable
      ? {
          to: splitAddresses(toInput?.input.value ?? ''),
          cc: ccInput ? splitAddresses(ccInput.input.value) : [],
          subject: subjectInput?.input.value ?? subject,
          body: bodyInput?.input.value ?? body,
        }
      : undefined;
    const sent = await bridge.callTool('outlook_send_draft_confirm', {
      draftId,
      ...(overrides ? { overrides } : {}),
    });
    if (sent.isError) throw new Error(resultText(sent) || 'Send failed');
    const finalTo = overrides ? overrides.to.join(', ') : to || 'the original recipients';
    const finalSubject = overrides ? overrides.subject : subject;
    finishDone({
      icon: 'sent',
      headline: 'Sent',
      detail: `To ${finalTo}${finalSubject ? ` — “${finalSubject}”` : ''}`,
    });
    bridge.updateModelContext(
      `The user reviewed the ${KIND_TITLES[kind] ?? 'email'} preview and sent it to ${finalTo}.`
    );
  });

  footer.run(discardButton, async () => {
    const discarded = await bridge.callTool('outlook_discard_draft_confirm', { draftId });
    if (discarded.isError) throw new Error(resultText(discarded) || 'Discard failed');
    finishDone({ icon: 'cancelled', headline: 'Discarded', detail: 'Nothing was sent.' });
    bridge.updateModelContext(
      'The user discarded the email draft from the preview card. Nothing was sent.'
    );
  });
}

const bridge = new WidgetBridge('renkei-email-compose');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
