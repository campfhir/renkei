/**
 * The push card's contract: the Action.Submit payload carries routing only
 * (message to capture, reply target) plus the command; the parse side
 * accepts exactly that shape and nothing else.
 */

import { buildPushToRenkeiCard, parsePushAction, CARD_COMMAND_PUSH } from './cards';

function actionsOf(card: ReturnType<typeof buildPushToRenkeiCard>): Array<Record<string, unknown>> {
  const actions = card.content.actions;
  return Array.isArray(actions) ? actions : [];
}

describe('buildPushToRenkeiCard', () => {
  it('is an adaptive card attachment with one push action carrying routing data', () => {
    const card = buildPushToRenkeiCard({ messageId: 'msg-1', replyTo: 'thread-1' });

    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const actions = actionsOf(card);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.data).toEqual({
      command: CARD_COMMAND_PUSH,
      messageId: 'msg-1',
      replyTo: 'thread-1',
    });
  });

  it('includes a note input the submit will carry', () => {
    const card = buildPushToRenkeiCard({ messageId: 'msg-1' });
    const body = Array.isArray(card.content.body) ? card.content.body : [];
    const hasNoteInput = body.some((element) => {
      if (typeof element !== 'object' || element === null) return false;
      const record: Record<string, unknown> = { ...element };
      return record.type === 'Input.Text';
    });
    expect(hasNoteInput).toBe(true);
  });
});

describe('parsePushAction', () => {
  it('round-trips the card payload with a submitted note', () => {
    expect(
      parsePushAction({
        command: CARD_COMMAND_PUSH,
        messageId: 'msg-1',
        replyTo: 'thread-1',
        note: '  needs eyes from infra  ',
      })
    ).toEqual({ messageId: 'msg-1', note: 'needs eyes from infra', replyTo: 'thread-1' });
  });

  it('treats a blank note as no note', () => {
    expect(
      parsePushAction({ command: CARD_COMMAND_PUSH, messageId: 'msg-1', note: '   ' })?.note
    ).toBeNull();
  });

  it('rejects foreign commands and missing message ids', () => {
    expect(parsePushAction({ command: 'something_else', messageId: 'msg-1' })).toBeNull();
    expect(parsePushAction({ command: CARD_COMMAND_PUSH })).toBeNull();
  });
});
