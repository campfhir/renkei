/**
 * The barge-in rules, pinned: a reply being read is cut only by a few
 * words; a reply still being worked out is never cut, and what is said
 * queues; a short sound under the voice is not a message.
 */

import { beginUtterance, holdUtterance, utteranceIsMessage } from './barge-in';

const speaking = { responding: true, asking: false };
const thinking = { responding: false, asking: false };
const idle = { responding: false, asking: false };
const asking = { responding: true, asking: true };

describe('barge-in', () => {
  it('a few words over the reply interrupt it, and are the next message', () => {
    const utterance = beginUtterance(speaking);
    expect(holdUtterance(utterance, speaking)).toBe(true);
    expect(utterance.interrupted).toBe(true);
    // The reply stopped on the interrupt; the assistant is idle by the close.
    expect(utteranceIsMessage(utterance, idle)).toBe(true);
  });

  it('a short sound over the reply neither interrupts nor sends', () => {
    const utterance = beginUtterance(speaking);
    // Never held: the recorder saw too little voice.
    expect(utterance.interrupted).toBe(false);
    expect(utteranceIsMessage(utterance, speaking)).toBe(false);
  });

  it('a short sound that outlasts the reply is a message after all', () => {
    const utterance = beginUtterance(speaking);
    expect(utteranceIsMessage(utterance, idle)).toBe(true);
  });

  it('talking while the reply is worked out cuts nothing: it queues', () => {
    const utterance = beginUtterance(thinking);
    expect(holdUtterance(utterance, thinking)).toBe(false);
    expect(utterance.interrupted).toBe(false);
    expect(utteranceIsMessage(utterance, thinking)).toBe(true);
    // Even when the reply starts reading before the person has finished.
    expect(utteranceIsMessage(utterance, speaking)).toBe(true);
  });

  it('talking to an idle assistant is simply a message', () => {
    const utterance = beginUtterance(idle);
    expect(holdUtterance(utterance, idle)).toBe(false);
    expect(utteranceIsMessage(utterance, idle)).toBe(true);
  });

  it('while an ask is open, speech answers it and interrupts nothing', () => {
    const utterance = beginUtterance(asking);
    expect(utterance.overVoice).toBe(false);
    expect(holdUtterance(utterance, asking)).toBe(false);
    expect(utteranceIsMessage(utterance, asking)).toBe(true);
  });
});
