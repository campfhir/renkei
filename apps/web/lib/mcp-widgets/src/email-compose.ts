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
 * A draft card (`mode: 'draft'`, from outlook_draft_mail/outlook_draft_reply)
 * is the same form with no Send: Save writes the edits to the draft and the
 * card stays; Delete removes the draft. Leaving it alone keeps it in Drafts.
 *
 * A send card can also schedule: "Send later" picks a moment and Send becomes
 * Schedule, handing the confirm tool a `sendAt` (Exchange holds the message in
 * the Outbox until then).
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
  let draftId = str(draft.draftId);
  const kind = str(draft.kind) || 'compose';
  const isDraft = draft.mode === 'draft';

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
    el('div', 'card-title', `${isDraft ? 'Draft: ' : ''}${KIND_TITLES[kind] ?? 'Email'}`),
    el(
      'div',
      'card-subtitle',
      isDraft
        ? 'Saved in your Outlook Drafts — nothing is sent. Leave it be to keep it; Delete removes it.'
        : 'Review before it goes out — nothing is sent until you confirm.'
    )
  );

  const compose = kind === 'compose';
  // A reply's own text is rebuilt around the quoted thread from the message
  // it answers; a card from before previews carried that id keeps its text
  // read-only (its recipients and subject are still a plain PATCH).
  const messageId = str(draft.messageId);
  const commentEditable = !compose && messageId !== '';
  let to = strings(draft.to).join(', ');
  let cc = strings(draft.cc).join(', ');
  const bcc = strings(draft.bcc).join(', ');
  let subject = str(draft.subject);
  let body = str(draft.body);
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

  const sendLater = isDraft ? null : inputField('Send later (optional)', '');
  if (sendLater) {
    sendLater.input.type = 'datetime-local';
    card.append(sendLater.field);
  }
  const discardButton = el('button', undefined, isDraft ? 'Delete draft' : 'Discard');
  const sendButton = el('button', 'primary', isDraft ? 'Save draft' : 'Send');
  const footer = cardActions([discardButton, sendButton]);
  card.append(footer.actions);
  root.append(card);
  sendLater?.input.addEventListener('input', () => {
    sendButton.textContent = sendLater.input.value ? 'Schedule' : 'Send';
  });

  if (isDraft) {
    footer.run(sendButton, async () => {
      const finalTo = splitAddresses(toInput.input.value);
      const finalCc = ccInput ? splitAddresses(ccInput.input.value) : [];
      const finalSubject = subjectInput.input.value;
      const text = bodyInput ? bodyInput.input.value : body;
      const textEdited = text.trim() !== body.trim();
      if (!compose && commentEditable && textEdited && !text.trim() && kind !== 'forward') {
        throw new Error('Write the reply, or delete the draft.');
      }
      const overrides = compose
        ? { to: finalTo, cc: finalCc, subject: finalSubject, body: text }
        : {
            ...(finalTo.join(', ') !== to ? { to: finalTo } : {}),
            ...(ccInput && finalCc.join(', ') !== cc ? { cc: finalCc } : {}),
            ...(finalSubject.trim() !== subject.trim() ? { subject: finalSubject } : {}),
            ...(commentEditable && textEdited ? { comment: text } : {}),
          };
      const reenable = () => {
        for (const button of [discardButton, sendButton]) button.disabled = false;
      };
      if (Object.keys(overrides).length === 0) {
        footer.setStatus('Saved to Drafts', 'ok');
        reenable();
        return;
      }
      const saved = await bridge.callTool(
        'outlook_update_draft_confirm',
        {
          draftId,
          overrides,
          ...(!compose && 'comment' in overrides ? { replyTo: { messageId, kind } } : {}),
        },
        stateKey
      );
      if (saved.isError) throw new Error(resultText(saved) || 'Save failed');
      // A rebuilt reply is a new draft; later saves and Delete address that one.
      const next =
        typeof saved.structuredContent === 'object' && saved.structuredContent !== null
          ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            str((saved.structuredContent as Record<string, unknown>).draftId)
          : '';
      if (next) draftId = next;
      to = finalTo.join(', ');
      cc = finalCc.join(', ');
      subject = finalSubject;
      body = text;
      footer.setStatus('Saved to Drafts', 'ok');
      reenable();
      bridge.updateModelContext(
        'The user edited the email draft and saved it. Nothing was sent.',
        stateKey
      );
    });
  } else
    footer.run(sendButton, async () => {
      const finalTo = splitAddresses(toInput.input.value);
      const finalCc = ccInput ? splitAddresses(ccInput.input.value) : [];
      const finalSubject = subjectInput.input.value;
      let args: Record<string, unknown>;
      if (compose) {
        args = {
          overrides: {
            to: finalTo,
            cc: finalCc,
            subject: finalSubject,
            body: bodyInput?.input.value ?? body,
          },
        };
      } else {
        // A reply goes out as previewed unless something on it changed; only
        // a changed text needs the draft rebuilt (`replyTo`).
        const comment = bodyInput ? bodyInput.input.value : body;
        const textEdited = commentEditable && comment.trim() !== body.trim();
        if (textEdited && !comment.trim() && kind !== 'forward') {
          throw new Error('Write the reply, or discard it.');
        }
        const overrides = {
          ...(finalTo.join(', ') !== to ? { to: finalTo } : {}),
          ...(ccInput && finalCc.join(', ') !== cc ? { cc: finalCc } : {}),
          ...(finalSubject.trim() !== subject.trim() ? { subject: finalSubject } : {}),
          ...(textEdited ? { comment } : {}),
        };
        args = {
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
          ...(textEdited ? { replyTo: { messageId, kind } } : {}),
        };
      }
      if (finalTo.length === 0) throw new Error('Add someone to send it to.');
      let when: Date | null = null;
      if (sendLater?.input.value) {
        when = new Date(sendLater.input.value);
        if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60_000) {
          throw new Error('Pick a send time at least a minute from now.');
        }
      }
      const sent = await bridge.callTool(
        'outlook_send_draft_confirm',
        { draftId, ...args, ...(when ? { sendAt: when.toISOString() } : {}) },
        stateKey
      );
      if (sent.isError)
        throw new Error(resultText(sent) || (when ? 'Scheduling failed' : 'Send failed'));
      const sentTo = finalTo.join(', ');
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
    finishDone({
      icon: 'cancelled',
      headline: isDraft ? 'Draft deleted' : 'Discarded',
      detail: isDraft ? 'Removed from your Drafts. Nothing was sent.' : 'Nothing was sent.',
    });
    bridge.updateModelContext(
      isDraft
        ? 'The user deleted the email draft from its card. Nothing was sent.'
        : 'The user discarded the email draft from the preview card. Nothing was sent.',
      stateKey
    );
  });
}

const bridge = new WidgetBridge('renkei-email-compose');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
