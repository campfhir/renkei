/**
 * The voice conversation's behaviour (voice-mode.model.ts), as a person
 * talking to it would describe it. The browser specs (voice.spec.ts,
 * voice-barge-in.spec.ts) keep one real conversation each, through a
 * fake microphone: that the dialog opens, hears, sends and reads on the
 * real server, and fits a phone. Whether a sound is words is
 * lib/voice/barge-in.test.ts's; what "allow" means is
 * lib/voice/spoken-decision.test.ts's.
 */

import { beginUtterance } from '@/lib/voice/barge-in';
import {
  SEND_FAILED,
  STILL_WORKING_AFTER_MS,
  announceActivity,
  askNarration,
  correctionFor,
  decisionNarration,
  hintOf,
  initialVoiceMode,
  isResponding,
  keyAction,
  labelOf,
  lastSentence,
  microphoneWhileBusy,
  phaseOf,
  queuedLine,
  recorderMuted,
  replyExcerpt,
  routeUtterance,
  stillWorkingDue,
  takePress,
  talkEnabled,
  toneOf,
  voiceModeReducer,
  workingLine,
  type VoiceModeAction,
  type VoiceModeState,
} from './voice-mode.model';

const run = (actions: VoiceModeAction[], from: VoiceModeState = initialVoiceMode) =>
  actions.reduce(voiceModeReducer, from);

const ready = run([{ type: 'microphone-ready' }]);
const idle = { queueState: 'idle' as const, running: false };
const auto = { pushToTalk: false, echoCancellation: true, asking: false };

const READING = { responding: true, asking: false };
const WORKING = { responding: false, asking: false };
const ASKING = { responding: false, asking: true };
const REPLY = 'Two issues slipped out of the last sprint.';

describe('the phases of a conversation', () => {
  it('opens the microphone first, then listens', () => {
    expect(phaseOf(initialVoiceMode, idle)).toBe('starting');
    expect(labelOf('starting', initialVoiceMode, auto)).toBe('Opening the microphone…');
    expect(phaseOf(ready, idle)).toBe('listening');
    expect(labelOf('listening', ready, auto)).toBe('Listening');
  });

  it('goes listening → heard you → thinking → speaking → listening', () => {
    const heard = run([{ type: 'transcribing' }], ready);
    expect(phaseOf(heard, idle)).toBe('transcribing');
    expect(labelOf('transcribing', heard, auto)).toBe('Heard you…');

    // Between the words landing and the turn starting it does not fall back to "Listening".
    const sending = run([{ type: 'transcribed' }, { type: 'sending' }], heard);
    expect(phaseOf(sending, idle)).toBe('thinking');
    const sent = run([{ type: 'sent', ok: true }], sending);
    expect(phaseOf(sent, { queueState: 'idle', running: true })).toBe('thinking');
    expect(phaseOf(sent, { queueState: 'loading', running: false })).toBe('thinking');
    expect(labelOf('thinking', sent, auto)).toBe('Thinking…');

    expect(phaseOf(sent, { queueState: 'speaking', running: true })).toBe('speaking');
    expect(labelOf('speaking', sent, auto)).toBe('Speaking — talk to interrupt');
    expect(phaseOf(sent, idle)).toBe('listening');
  });

  it('says how to interrupt the voice the way this device can', () => {
    expect(labelOf('speaking', ready, { ...auto, echoCancellation: false })).toBe(
      'Speaking — press Stop to talk'
    );
    expect(labelOf('speaking', ready, { ...auto, pushToTalk: true })).toBe(
      'Speaking — press Talk to interrupt'
    );
  });

  it('cannot start without a microphone, and says so', () => {
    const failed = run([
      { type: 'microphone-failed', message: 'Microphone blocked', pushToTalk: false },
    ]);
    expect(phaseOf(failed, idle)).toBe('error');
    expect(labelOf('error', failed, auto)).toBe('Voice mode could not start');
    expect(failed.error).toBe('Microphone blocked');
  });

  it('with press-to-talk a refused microphone only fails that take; Talk can try again', () => {
    const failed = run(
      [{ type: 'microphone-failed', message: 'Microphone blocked', pushToTalk: true }],
      ready
    );
    expect(phaseOf(failed, idle)).toBe('listening');
    expect(failed.error).toBe('Microphone blocked');
    expect(run([{ type: 'take-opening' }], failed).error).toBeNull();
  });

  it('an open ask and a mute say so over everything but starting', () => {
    expect(labelOf('speaking', ready, { ...auto, asking: true })).toBe(
      'Permission needed — say allow, always allow, or deny'
    );
    const muted = run([{ type: 'mute-toggled' }], ready);
    expect(labelOf('listening', muted, auto)).toBe('Muted — unmute to talk');
    expect(run([{ type: 'mute-toggled' }], muted).muted).toBe(false);
  });
});

describe('press to talk', () => {
  const ptt = { ...auto, pushToTalk: true };

  it('waits for Talk, says it is opening, records, then sends on Done', () => {
    expect(labelOf('listening', ready, ptt)).toBe('Press Talk to speak');
    const opening = run([{ type: 'take-opening' }], ready);
    expect(labelOf(phaseOf(opening, idle), opening, ptt)).toBe('Opening the microphone…');
    expect(talkEnabled(phaseOf(opening, idle), opening.opening)).toBe(false);
    const recording = run([{ type: 'take-opened' }, { type: 'take-started' }], opening);
    expect(phaseOf(recording, { queueState: 'speaking', running: true })).toBe('recording');
    expect(labelOf('recording', recording, ptt)).toBe(
      'Recording — press Done when you have finished'
    );
    expect(phaseOf(run([{ type: 'take-ended' }], recording), idle)).toBe('listening');
  });

  it('Talk over a reply being read cuts it; over one still worked out, or an ask, it does not', () => {
    const press = { opening: false, taking: false };
    expect(takePress({ ...press, ...READING })).toEqual({ kind: 'begin', interrupt: true });
    expect(takePress({ ...press, ...WORKING })).toEqual({ kind: 'begin', interrupt: false });
    expect(takePress({ ...press, responding: true, asking: true })).toEqual({
      kind: 'begin',
      interrupt: false,
    });
  });

  it('Done ends an open take; nothing happens while the microphone is still opening', () => {
    expect(takePress({ opening: false, taking: true, ...READING })).toEqual({ kind: 'end' });
    expect(takePress({ opening: true, taking: false, ...READING })).toBeNull();
  });

  it('Space is Talk/Done unless a control has the keyboard; Escape always leaves', () => {
    const key = { pushToTalk: true, phase: 'listening' as const, onControl: false };
    expect(keyAction({ ...key, key: ' ' })).toBe('take');
    expect(keyAction({ ...key, key: ' ', onControl: true })).toBeNull();
    expect(keyAction({ ...key, key: ' ', pushToTalk: false })).toBeNull();
    expect(keyAction({ ...key, key: ' ', phase: 'starting' })).toBeNull();
    expect(keyAction({ ...key, key: 'Escape', onControl: true })).toBe('close');
    expect(keyAction({ ...key, key: 'a' })).toBeNull();
  });

  it('a recovered microphone forgets a refused one', () => {
    const failed = run([{ type: 'microphone-failed', message: 'x', pushToTalk: false }]);
    expect(phaseOf(run([{ type: 'microphone-ready' }], failed), idle)).toBe('listening');
  });

  it('a recorder torn down mid-take leaves no take open', () => {
    const recording = run([{ type: 'take-opening' }, { type: 'take-started' }], ready);
    const reset = run([{ type: 'recorder-reset' }], recording);
    expect(reset.recording).toBe(false);
    expect(reset.opening).toBe(false);
  });
});

describe('the wave', () => {
  it('moves with the speaker while speaking and the microphone while listening', () => {
    expect(toneOf('speaking', false, false)).toBe('speaking');
    expect(toneOf('thinking', false, false)).toBe('thinking');
    expect(toneOf('transcribing', false, false)).toBe('thinking');
    expect(toneOf('listening', false, false)).toBe('listening');
    expect(toneOf('recording', false, true)).toBe('listening');
  });

  it('lies still while muted, and while press-to-talk waits for Talk', () => {
    expect(toneOf('listening', true, false)).toBe('idle');
    expect(toneOf('listening', false, true)).toBe('idle');
    expect(toneOf('starting', false, false)).toBe('idle');
  });
});

describe('what an utterance becomes', () => {
  const route = (text: string, assistant: typeof READING, over = assistant, pushToTalk = false) =>
    routeUtterance({
      text,
      pushToTalk,
      closed: beginUtterance(over),
      assistant,
      spokenReply: REPLY,
    });

  it('said with the assistant quiet, it is sent as the next message', () => {
    expect(route('Which tickets slipped?', WORKING)).toEqual({ kind: 'send', interrupt: false });
  });

  it('said while the reply is still being worked out, it is sent without stopping anything', () => {
    expect(route('And the one before?', WORKING)).toEqual({ kind: 'send', interrupt: false });
  });

  it('words said over a reply being read cut it and are sent', () => {
    expect(route('Wait, what about the bugs?', READING)).toEqual({ kind: 'send', interrupt: true });
  });

  it('a "yeah" or the reply’s own echo under the voice is dropped, not sent', () => {
    expect(route('yeah', READING)).toEqual({ kind: 'drop' });
    expect(route('two issues slipped out of the last sprint', READING)).toEqual({ kind: 'drop' });
  });

  it('nothing heard is nothing sent', () => {
    expect(route('   ', WORKING)).toEqual({ kind: 'drop' });
  });

  it('a press-to-talk take is always a message, even a "yeah" over the voice', () => {
    expect(route('yeah', READING, READING, true)).toEqual({ kind: 'send', interrupt: false });
  });

  it('while an ask is open, what is said answers it', () => {
    expect(route('yes, go ahead', ASKING)).toEqual({
      kind: 'answer',
      interrupt: false,
      decision: 'once',
    });
    expect(route('always allow', ASKING)).toMatchObject({ decision: 'always' });
    expect(route('no', ASKING)).toMatchObject({ decision: 'deny' });
    expect(route('what is the weather', ASKING)).toMatchObject({ kind: 'answer', decision: null });
  });

  it('does not mark the closed utterance (the recorder still owns it)', () => {
    const closed = beginUtterance(READING);
    routeUtterance({
      text: 'Stop there',
      pushToTalk: false,
      closed,
      assistant: READING,
      spokenReply: '',
    });
    expect(closed.interrupted).toBe(false);
  });

  it('shows what was heard, and in which language when it was not the set one', () => {
    const heard = run([
      { type: 'recognition-failed', message: 'old' },
      { type: 'utterance-heard', text: 'Hola', heardIn: 'es-ES', locale: 'en-GB' },
    ]);
    expect(heard).toMatchObject({ transcript: 'Hola', heard: 'es-ES', error: null });
    const same = run([{ type: 'utterance-heard', text: 'Hi', heardIn: 'en-GB', locale: 'en-GB' }]);
    expect(same.heard).toBeNull();
  });

  it('a send that fails says so', () => {
    const failed = run([{ type: 'sending' }, { type: 'sent', ok: false }], ready);
    expect(failed.error).toBe(SEND_FAILED);
    expect(failed.sending).toBe(false);
  });

  it('a recognition that fails says why', () => {
    expect(run([{ type: 'recognition-failed', message: 'Speech service down' }]).error).toBe(
      'Speech service down'
    );
  });
});

describe('an utterance heard in another language', () => {
  const sent = { locale: 'en-GB', seq: 3, lastSentSeq: 3 };

  it('is resent in the words heard in that language', () => {
    expect(
      correctionFor({ ...sent, detectedIn: 'fr-FR', text: ' Quels tickets ont glissé ? ' })
    ).toEqual({ kind: 'correct', locale: 'fr-FR', text: 'Quels tickets ont glissé ?' });
    const shown = run([
      { type: 'utterance-heard', text: 'Kel tickets', heardIn: 'en-GB', locale: 'en-GB' },
      { type: 'corrected', text: 'Quels tickets ont glissé ?', locale: 'fr-FR' },
    ]);
    expect(shown).toMatchObject({ transcript: 'Quels tickets ont glissé ?', heard: 'fr-FR' });
  });

  it('in the same language, another region, leaves the words as sent', () => {
    expect(correctionFor({ ...sent, detectedIn: 'en-US', text: 'Hello' })).toEqual({
      kind: 'heard',
      locale: 'en-US',
    });
  });

  it('corrects nothing once a newer utterance has gone out', () => {
    expect(correctionFor({ ...sent, lastSentSeq: 4, detectedIn: 'fr-FR', text: 'Oui' })).toEqual({
      kind: 'none',
    });
  });

  it('corrects nothing when the detection had no answer', () => {
    expect(correctionFor({ ...sent, detectedIn: null, text: 'Oui' })).toEqual({ kind: 'none' });
    expect(correctionFor({ ...sent, detectedIn: 'fr-FR', text: ' ' })).toEqual({ kind: 'none' });
  });
});

describe('saying what it is doing', () => {
  it('reads the reply as responding only when words are sounding and no call runs', () => {
    expect(isResponding({ queueState: 'speaking', spokenReply: REPLY, activityCount: 0 })).toBe(
      true
    );
    expect(isResponding({ queueState: 'speaking', spokenReply: REPLY, activityCount: 1 })).toBe(
      false
    );
    expect(isResponding({ queueState: 'speaking', spokenReply: '', activityCount: 0 })).toBe(false);
    expect(isResponding({ queueState: 'idle', spokenReply: REPLY, activityCount: 0 })).toBe(false);
  });

  it('announces a call the model did not introduce, and shows it under the wave', () => {
    const first = announceActivity([], [{ id: 't1', name: 'jira_search_issues', said: null }]);
    expect(first).toEqual({
      announced: ['t1'],
      line: 'Searching Jira issues',
      narration: 'Searching Jira issues.',
    });
    expect(
      workingLine({
        running: true,
        asking: false,
        phase: 'thinking',
        activityLine: first.line,
        thinking: false,
      })
    ).toBe('Searching Jira issues…');
  });

  it('a call the model introduced shows its own last sentence and is not said twice', () => {
    const next = announceActivity(
      [],
      [{ id: 't1', name: 'jira_search_issues', said: 'Let me look. I will check Jira.' }]
    );
    expect(next.line).toBe('I will check Jira');
    expect(next.narration).toBeNull();
  });

  it('a burst of calls is one sentence, for the newest; an announced call is not announced again', () => {
    const calls = [
      { id: 'a', name: 'jira_search_issues', said: null },
      { id: 'b', name: 'confluence_search_pages', said: null },
    ];
    const burst = announceActivity([], calls);
    expect(burst.announced).toEqual(['a', 'b']);
    expect(burst.narration).toMatch(/Confluence/);
    const again = announceActivity(burst.announced, calls);
    expect(again.narration).toBeNull();
    expect(again.line).toBe(burst.line);
    expect(announceActivity(burst.announced, []).line).toBeNull();
  });

  it('a finished turn forgets what it announced', () => {
    const announced = run([
      { type: 'activity-changed', activity: [{ id: 'a', name: 'jira_search_issues', said: null }] },
    ]);
    expect(announced.activityLine).toBe('Searching Jira issues');
    expect(run([{ type: 'turn-finished' }], announced).announced).toEqual([]);
  });

  it('while thinking with no call, says it is thinking or working; nothing over an ask', () => {
    const base = { running: true, asking: false, phase: 'thinking' as const, activityLine: null };
    expect(workingLine({ ...base, thinking: true })).toBe('Thinking it through…');
    expect(workingLine({ ...base, thinking: false })).toBe('Working…');
    expect(workingLine({ ...base, phase: 'speaking', thinking: false })).toBeNull();
    expect(workingLine({ ...base, asking: true, activityLine: 'x', thinking: false })).toBeNull();
    expect(workingLine({ ...base, running: false, thinking: false })).toBeNull();
  });

  it('a long quiet while the reply is worked out earns "still working on it"', () => {
    expect(stillWorkingDue('idle', 0, STILL_WORKING_AFTER_MS)).toBe(true);
    expect(stillWorkingDue('idle', 0, STILL_WORKING_AFTER_MS - 1)).toBe(false);
    expect(stillWorkingDue('speaking', 0, STILL_WORKING_AFTER_MS * 2)).toBe(false);
  });

  it('the line under the wave keeps the last sentence, without its stop', () => {
    expect(lastSentence('First. Then the second!')).toBe('Then the second');
    expect(lastSentence('Only one')).toBe('Only one');
  });

  it('the reply panel keeps the last 700 characters of a long reply', () => {
    expect(replyExcerpt('short')).toBe('short');
    const long = 'x'.repeat(701);
    expect(replyExcerpt(long)).toBe(`…${'x'.repeat(700)}`);
  });

  it('an empty conversation explains itself, in the mode it is in', () => {
    const base = { phase: 'listening' as const, transcript: null, spokenReply: '' };
    expect(hintOf({ ...base, pushToTalk: false })).toMatch(/^Say something/);
    expect(hintOf({ ...base, pushToTalk: true })).toMatch(/^Press Talk/);
    expect(hintOf({ ...base, transcript: 'hi', pushToTalk: false })).toBeNull();
    expect(hintOf({ ...base, phase: 'thinking', pushToTalk: false })).toBeNull();
  });
});

describe('the queued next message', () => {
  it('says one message is queued, or how many, while the reply is busy', () => {
    expect(queuedLine(1, true)).toBe(
      'Your next message is queued — it goes out when this reply is done.'
    );
    expect(queuedLine(2, true)).toBe(
      '2 messages are queued — they go out one at a time when this reply is done.'
    );
  });

  it('says nothing once it has gone out, or once the reply is done', () => {
    expect(queuedLine(0, true)).toBeNull();
    expect(queuedLine(1, false)).toBeNull();
  });
});

describe('asking before it acts', () => {
  it('speaks the ask and tells the person what to say', () => {
    expect(askNarration('jira_create_issue')).toBe(
      'Permission needed. The assistant wants to create Jira issue. Say allow, always allow, or deny.'
    );
  });

  it('says the answer back', () => {
    expect(decisionNarration('once')).toBe('Allowed.');
    expect(decisionNarration('always')).toBe('Always allowed.');
    expect(decisionNarration('deny')).toBe('Denied.');
  });

  it('shows the answer being recorded, and why it was refused', () => {
    const deciding = run([{ type: 'deciding', decision: 'once' }]);
    expect(deciding.deciding).toBe('once');
    const refused = run([{ type: 'decided', failure: 'Only the owner can decide' }], deciding);
    expect(refused).toMatchObject({ deciding: null, decisionError: 'Only the owner can decide' });
    expect(run([{ type: 'ask-raised' }], refused).decisionError).toBeNull();
  });
});

describe('the microphone, and a headset', () => {
  const base = { pushToTalk: false, echoCancellation: false, phase: 'thinking' as const };

  it('without echo cancellation, is released while the assistant works and opened after', () => {
    expect(microphoneWhileBusy({ ...base, busy: true, active: true })).toBe('stop');
    expect(microphoneWhileBusy({ ...base, phase: 'listening', busy: false, active: false })).toBe(
      'start'
    );
    expect(
      microphoneWhileBusy({ ...base, phase: 'listening', busy: false, active: true })
    ).toBeNull();
  });

  it('with echo cancellation or press-to-talk, is left alone; and never before it has opened', () => {
    expect(
      microphoneWhileBusy({ ...base, echoCancellation: true, busy: true, active: true })
    ).toBeNull();
    expect(microphoneWhileBusy({ ...base, pushToTalk: true, busy: true, active: true })).toBeNull();
    expect(
      microphoneWhileBusy({ ...base, phase: 'starting', busy: false, active: false })
    ).toBeNull();
    expect(microphoneWhileBusy({ ...base, phase: 'error', busy: false, active: false })).toBeNull();
  });

  it('hears nothing while muted, or while the speaker talks without echo cancellation', () => {
    const quiet = { muted: false, pushToTalk: false, echoCancellation: false };
    expect(recorderMuted({ ...quiet, queueState: 'speaking' })).toBe(true);
    expect(recorderMuted({ ...quiet, queueState: 'idle' })).toBe(false);
    expect(recorderMuted({ ...quiet, echoCancellation: true, queueState: 'speaking' })).toBe(false);
    expect(recorderMuted({ ...quiet, pushToTalk: true, queueState: 'speaking' })).toBe(false);
    expect(
      recorderMuted({ ...quiet, muted: true, echoCancellation: true, queueState: 'idle' })
    ).toBe(true);
  });
});
