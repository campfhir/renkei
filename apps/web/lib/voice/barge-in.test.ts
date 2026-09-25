/**
 * The barge-in rules, pinned: a reply being read is cut only by words
 * the recognizer heard — not a sound, not a backchannel, not its own
 * echo; a reply still being worked out is never cut, and what is said
 * queues; a sound under the voice that never became words is dropped,
 * and one that did cuts the reply when it closes.
 */

import {
  beginUtterance,
  closeUtterance,
  holdUtterance,
  holdWorthJudging,
  readsAsWords,
  wordsOf,
} from './barge-in';

const speaking = { responding: true, asking: false };
const thinking = { responding: false, asking: false };
const idle = { responding: false, asking: false };
const asking = { responding: true, asking: true };

const REPLY =
  'Two issues slipped out of the last sprint. OPS-41, rotating the Zoom webhook secret, is still in progress with Priya.';

describe('readsAsWords', () => {
  it('hears words in a sentence, and none in silence or a sound', () => {
    expect(readsAsWords('Wait, stop there.')).toBe(true);
    expect(readsAsWords('stop')).toBe(true);
    expect(readsAsWords('')).toBe(false);
    expect(readsAsWords('   ')).toBe(false);
    expect(readsAsWords('...')).toBe(false);
  });

  it('does not count a backchannel as taking the floor', () => {
    expect(readsAsWords('Mm-hm.')).toBe(false);
    expect(readsAsWords('Yeah.')).toBe(false);
    expect(readsAsWords('Okay, right.')).toBe(false);
    expect(readsAsWords('Uh-huh, go on.')).toBe(false);
    expect(readsAsWords('I see.')).toBe(false);
    expect(readsAsWords('Thank you.')).toBe(false);
    // One real word among them is enough.
    expect(readsAsWords('Yeah, but what about OPS-44?')).toBe(true);
    expect(readsAsWords('Okay stop.')).toBe(true);
  });

  it('does not take the reply’s own words, heard through the microphone, for the person', () => {
    expect(readsAsWords('rotating the Zoom webhook secret', REPLY)).toBe(false);
    expect(readsAsWords('Two issues slipped out', REPLY)).toBe(false);
    // Short snippets are not compared: "in progress" is the person's to say too.
    expect(readsAsWords('in progress', REPLY)).toBe(true);
    // A run of words not in the reply is the person.
    expect(readsAsWords('what about the file share one', REPLY)).toBe(true);
  });

  it('splits words the way the recognizer writes them', () => {
    expect(wordsOf("Mm-hm, that's OPS-41.")).toEqual(['mm', 'hm', "that's", 'ops', '41']);
    expect(wordsOf('’Tis done.')).toEqual(['tis', 'done']);
  });
});

describe('barge-in', () => {
  it('only a reply being read is worth asking the recognizer about', () => {
    expect(holdWorthJudging(speaking)).toBe(true);
    expect(holdWorthJudging(thinking)).toBe(false);
    expect(holdWorthJudging(idle)).toBe(false);
    expect(holdWorthJudging(asking)).toBe(false);
  });

  it('words over the reply interrupt it, and are the next message', () => {
    const utterance = beginUtterance(speaking);
    expect(holdUtterance(utterance, speaking, 'Wait, what about', REPLY)).toBe(true);
    expect(utterance.interrupted).toBe(true);
    // The reply stopped on the interrupt; the assistant is idle by the close.
    expect(closeUtterance(utterance, idle, 'Wait, what about the other one?', REPLY)).toBe('send');
  });

  it('a sound over the reply that the recognizer hears nothing in interrupts nothing', () => {
    const utterance = beginUtterance(speaking);
    expect(holdUtterance(utterance, speaking, '', REPLY)).toBe(false);
    expect(utterance.interrupted).toBe(false);
    expect(closeUtterance(utterance, speaking, '', REPLY)).toBe('drop');
  });

  it('a backchannel over the reply neither interrupts nor sends', () => {
    const utterance = beginUtterance(speaking);
    expect(holdUtterance(utterance, speaking, 'Mm-hm.', REPLY)).toBe(false);
    expect(closeUtterance(utterance, speaking, 'Mm-hm, yeah.', REPLY)).toBe('drop');
    // Even once the reply has finished: it was never a message.
    expect(closeUtterance(utterance, idle, 'Okay.', REPLY)).toBe('drop');
  });

  it('the reply’s own echo over the reply is not the person', () => {
    const utterance = beginUtterance(speaking);
    expect(holdUtterance(utterance, speaking, 'rotating the Zoom webhook', REPLY)).toBe(false);
    expect(closeUtterance(utterance, speaking, 'rotating the Zoom webhook secret', REPLY)).toBe(
      'drop'
    );
  });

  it('words that only came after the first judgement cut the reply at the close', () => {
    const utterance = beginUtterance(speaking);
    // A throat cleared: nothing in the snippet.
    expect(holdUtterance(utterance, speaking, '', REPLY)).toBe(false);
    // ...then a sentence, with the reply still being read.
    expect(closeUtterance(utterance, speaking, 'Hang on, which sprint?', REPLY)).toBe('interrupt');
    expect(utterance.interrupted).toBe(true);
  });

  it('words that outlast the reply are simply a message', () => {
    const utterance = beginUtterance(speaking);
    expect(closeUtterance(utterance, idle, 'Which sprint was that?', REPLY)).toBe('send');
  });

  it('talking while the reply is worked out cuts nothing: it queues', () => {
    const utterance = beginUtterance(thinking);
    expect(utterance.overVoice).toBe(false);
    expect(holdUtterance(utterance, thinking, 'And also OPS-44.', '')).toBe(false);
    expect(utterance.interrupted).toBe(false);
    expect(closeUtterance(utterance, thinking, 'And also OPS-44.', '')).toBe('send');
    // Even when the reply starts reading before the person has finished.
    expect(closeUtterance(utterance, speaking, 'And also OPS-44.', REPLY)).toBe('send');
    // And even a bare "okay" said to a thinking assistant is theirs to send.
    expect(closeUtterance(beginUtterance(thinking), thinking, 'Okay.', '')).toBe('send');
  });

  it('talking to an idle assistant is simply a message, backchannel or not', () => {
    const utterance = beginUtterance(idle);
    expect(holdUtterance(utterance, idle, 'Yes.', '')).toBe(false);
    expect(closeUtterance(utterance, idle, 'Yes.', '')).toBe('send');
  });

  it('while an ask is open, speech answers it and interrupts nothing', () => {
    const utterance = beginUtterance(asking);
    expect(utterance.overVoice).toBe(false);
    expect(holdUtterance(utterance, asking, 'Allow.', '')).toBe(false);
    expect(closeUtterance(utterance, asking, 'Allow.', '')).toBe('send');
  });
});
