/**
 * The immersive voice conversation's behaviour (voice-mode.tsx), with no
 * microphone, speaker, timer or React: which phase the session is in and
 * what the line under the wave says, what an utterance becomes once its
 * words are back (dropped, an answer to an ask, a message — cutting the
 * reply first or not), whether the slower language answer corrects what
 * was sent, what is announced while a tool call runs, when the
 * microphone is released and muted, and what Talk does.
 *
 * The component keeps the recorder, the recognizer's calls, the speech
 * queue and the timers; it dispatches what happened (the microphone
 * opened, a take began, the words came back, the send answered) and
 * renders from the state and the selectors here. Tested in
 * voice-mode.model.test.ts.
 */

import type { ToolPermissionDecision } from '@/lib/chat/views';
import { spokenActivity, spokenAsk } from '@/lib/voice/activity';
import { closeUtterance, type AssistantState, type Utterance } from '@/lib/voice/barge-in';
import { spokenDecision } from '@/lib/voice/spoken-decision';
import type { SpeechQueueState } from '@/lib/voice/speech-queue';

/** A tool call in flight, for the activity line and its announcement. */
export interface VoiceActivity {
  id: string;
  name: string;
  /** What the model wrote just before the call — its own account of it, read aloud already. */
  said: string | null;
}

export type Phase =
  'starting' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface VoiceModeState {
  /** The microphone: still opening, open (or wanted per take), or refused for good. */
  microphone: 'starting' | 'ready' | 'error';
  error: string | null;
  muted: boolean;
  /** Push-to-talk: a take is open, between Talk and Done. */
  recording: boolean;
  /** Push-to-talk: the microphone is opening for a take. */
  opening: boolean;
  /** An utterance's words are being recognised. */
  transcribing: boolean;
  /** The utterance is words and on its way to being a turn. */
  sending: boolean;
  /** What the person last said, as the dialog shows it. */
  transcript: string | null;
  /** The language the last utterance was heard in, when it was not the set one. */
  heard: string | null;
  /** Tool calls already announced in this turn. */
  announced: string[];
  /** What the assistant is doing, as last announced. */
  activityLine: string | null;
  /** The ask's answer being recorded. */
  deciding: ToolPermissionDecision | null;
  decisionError: string | null;
}

export const initialVoiceMode: VoiceModeState = {
  microphone: 'starting',
  error: null,
  muted: false,
  recording: false,
  opening: false,
  transcribing: false,
  sending: false,
  transcript: null,
  heard: null,
  announced: [],
  activityLine: null,
  deciding: null,
  decisionError: null,
};

export type VoiceModeAction =
  /** The microphone opened (or, press-to-talk, is wanted only per take). */
  | { type: 'microphone-ready' }
  /** The recorder failed; without press-to-talk there is no voice mode after it. */
  | { type: 'microphone-failed'; message: string; pushToTalk: boolean }
  /** The recorder was torn down (settings changed, or the dialog closed). */
  | { type: 'recorder-reset' }
  | { type: 'mute-toggled' }
  /** Press-to-talk: Talk was pressed and the microphone is opening for the take. */
  | { type: 'take-opening' }
  | { type: 'take-opened' }
  /** Press-to-talk: the take began / the recorder closed it. */
  | { type: 'take-started' }
  | { type: 'take-ended' }
  | { type: 'transcribing' }
  | { type: 'transcribed' }
  | { type: 'recognition-failed'; message: string }
  /** The utterance's words are in and it is going somewhere (not dropped). */
  | { type: 'utterance-heard'; text: string; heardIn: string | null; locale: string }
  | { type: 'sending' }
  | { type: 'sent'; ok: boolean }
  /** The slower answer heard it in another language: these are its words. */
  | { type: 'corrected'; text: string; locale: string }
  | { type: 'activity-changed'; activity: VoiceActivity[] }
  /** The turn is over: the next one's calls are announced afresh. */
  | { type: 'turn-finished' }
  /** A new ask was raised. */
  | { type: 'ask-raised' }
  | { type: 'deciding'; decision: ToolPermissionDecision }
  | { type: 'decided'; failure: string | null };

export const SEND_FAILED = 'The message could not be sent.';

export function voiceModeReducer(state: VoiceModeState, action: VoiceModeAction): VoiceModeState {
  switch (action.type) {
    case 'microphone-ready':
      return { ...state, microphone: 'ready' };
    case 'microphone-failed':
      return {
        ...state,
        error: action.message,
        microphone: action.pushToTalk ? state.microphone : 'error',
      };
    case 'recorder-reset':
      return { ...state, recording: false, opening: false };
    case 'mute-toggled':
      return { ...state, muted: !state.muted };
    case 'take-opening':
      return { ...state, error: null, opening: true };
    case 'take-opened':
      return { ...state, opening: false };
    case 'take-started':
      return { ...state, recording: true };
    case 'take-ended':
      return { ...state, recording: false };
    case 'transcribing':
      return { ...state, transcribing: true };
    case 'transcribed':
      return { ...state, transcribing: false };
    case 'recognition-failed':
      return { ...state, error: action.message };
    case 'utterance-heard':
      return {
        ...state,
        error: null,
        transcript: action.text,
        heard: action.heardIn && action.heardIn !== action.locale ? action.heardIn : null,
      };
    case 'sending':
      return { ...state, sending: true };
    case 'sent':
      return { ...state, sending: false, error: action.ok ? state.error : SEND_FAILED };
    case 'corrected':
      return { ...state, transcript: action.text, heard: action.locale };
    case 'activity-changed': {
      const next = announceActivity(state.announced, action.activity);
      return { ...state, announced: next.announced, activityLine: next.line };
    }
    case 'turn-finished':
      return state.announced.length === 0 ? state : { ...state, announced: [] };
    case 'ask-raised':
      return { ...state, decisionError: null };
    case 'deciding':
      return { ...state, deciding: action.decision, decisionError: null };
    case 'decided':
      return { ...state, deciding: null, decisionError: action.failure };
  }
}

/* --------------------------------------------------------------------- */
/* What the assistant is doing                                           */

/** The last sentence of what the model said, for the line under the wave. */
export function lastSentence(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g);
  const last = sentences?.[sentences.length - 1]?.trim();
  return (last && last.length > 0 ? last : text).replace(/[.!?]+$/, '');
}

function lineOf(call: VoiceActivity): string {
  return call.said ? lastSentence(call.said) : spokenActivity(call.name);
}

/**
 * The tool calls running now, against those already announced: the line
 * under the wave (the model's own sentence about the call when it wrote
 * one, else the page's), and what to say aloud — only for a call the
 * model did not introduce, and only the newest of a burst, so several
 * lookups starting at once are one sentence.
 */
export function announceActivity(
  announced: readonly string[],
  activity: readonly VoiceActivity[]
): { announced: string[]; line: string | null; narration: string | null } {
  const seen = new Set(announced);
  const fresh = activity.filter((call) => !seen.has(call.id));
  const next = [...announced, ...fresh.map((call) => call.id)];
  const newest = fresh[fresh.length - 1];
  if (newest) {
    return {
      announced: next,
      line: lineOf(newest),
      narration: newest.said ? null : `${spokenActivity(newest.name)}.`,
    };
  }
  const current = activity[activity.length - 1];
  return { announced: next, line: current ? lineOf(current) : null, narration: null };
}

/** Quiet this long while a reply is worked out earns a "still working on it". */
export const STILL_WORKING_AFTER_MS = 20_000;

/** Whether a check of the quiet, at `now`, should say "Still working on it." */
export function stillWorkingDue(queueState: SpeechQueueState, lastVoiceAt: number, now: number) {
  return queueState === 'idle' && now - lastVoiceAt >= STILL_WORKING_AFTER_MS;
}

/** The ask, spoken the moment it is raised. */
export function askNarration(toolName: string): string {
  return `Permission needed. The assistant wants to ${spokenAsk(toolName)}. Say allow, always allow, or deny.`;
}

/** Said back once the ask is answered, so the person knows it was heard. */
export function decisionNarration(decision: ToolPermissionDecision): string {
  return decision === 'deny' ? 'Denied.' : decision === 'always' ? 'Always allowed.' : 'Allowed.';
}

export const ASK_AGAIN = 'Say allow, always allow, or deny.';

/* --------------------------------------------------------------------- */
/* Utterances                                                            */

/**
 * The assistant is reading its answer: words of the reply are sounding
 * (or queued to), with no tool call in flight. Not a narration and not
 * the model thinking: those are the reply being worked out, which talking
 * over does not cut (lib/voice/barge-in.ts).
 */
export function isResponding(input: {
  queueState: SpeechQueueState;
  spokenReply: string;
  activityCount: number;
}): boolean {
  return input.queueState !== 'idle' && input.spokenReply.length > 0 && input.activityCount === 0;
}

/** What an utterance becomes once its words are back. */
export type UtteranceRoute =
  /** Nothing said, or a sound under the voice that never became words. */
  | { kind: 'drop' }
  /** An ask is open: the words answer it (or, when they do not, it is asked again). */
  | { kind: 'answer'; interrupt: boolean; decision: ToolPermissionDecision | null }
  /** A message, sent as the next turn (cutting the reply being read first, when `interrupt`). */
  | { kind: 'send'; interrupt: boolean };

/**
 * Route a closed utterance. Under the assistant's voice only words are a
 * message: a "yeah" or the reply's own echo is dropped, and words that
 * became words only now cut the reply. A press-to-talk take is always a
 * message: a button was pressed for it. While an ask is open, what is
 * said is the answer to it. (`closed` is not changed.)
 */
export function routeUtterance(input: {
  text: string;
  pushToTalk: boolean;
  closed: Utterance;
  assistant: AssistantState;
  spokenReply: string;
}): UtteranceRoute {
  const text = input.text.trim();
  if (!text) return { kind: 'drop' };
  const decision = input.pushToTalk
    ? 'send'
    : closeUtterance({ ...input.closed }, input.assistant, text, input.spokenReply);
  if (decision === 'drop') return { kind: 'drop' };
  const interrupt = decision === 'interrupt';
  if (input.assistant.asking) return { kind: 'answer', interrupt, decision: spokenDecision(text) };
  return { kind: 'send', interrupt };
}

/** The language of a locale, so `en-GB` and `en-US` are the same one. */
export function languageOf(locale: string): string {
  return locale.split('-')[0].toLowerCase();
}

/** What the slower, language-detecting answer does to an utterance already sent. */
export type CorrectionOutcome =
  /** Nothing: no answer, no words, or something newer has gone out since. */
  | { kind: 'none' }
  /** The same language (whatever the region): the reply is spoken in it, the words stand. */
  | { kind: 'heard'; locale: string }
  /** Another language: its words replace what was sent, and the reply is spoken in it. */
  | { kind: 'correct'; locale: string; text: string };

/**
 * The detection came back for utterance `seq`. A different language means
 * the words were heard wrong, and the words heard in that language
 * replace them — unless a newer utterance went out since, since resending
 * the older would drop the newer. An error is no one's problem: the words
 * went out already, in the set language.
 */
export function correctionFor(input: {
  detectedIn: string | null;
  text: string;
  locale: string;
  seq: number;
  lastSentSeq: number | null;
}): CorrectionOutcome {
  const words = input.text.trim();
  if (!input.detectedIn || !words || input.lastSentSeq !== input.seq) return { kind: 'none' };
  if (languageOf(input.detectedIn) === languageOf(input.locale)) {
    return { kind: 'heard', locale: input.detectedIn };
  }
  return { kind: 'correct', locale: input.detectedIn, text: words };
}

/* --------------------------------------------------------------------- */
/* The screen                                                            */

/** What is happening right now, from the state and what the thread and speaker are doing. */
export function phaseOf(
  state: VoiceModeState,
  outside: { queueState: SpeechQueueState; running: boolean }
): Phase {
  if (state.microphone === 'starting') return 'starting';
  if (state.microphone === 'error') return 'error';
  if (state.recording) return 'recording';
  if (outside.queueState === 'speaking') return 'speaking';
  if (state.transcribing) return 'transcribing';
  if (outside.running || state.sending || outside.queueState === 'loading') return 'thinking';
  return 'listening';
}

export interface ScreenContext {
  pushToTalk: boolean;
  echoCancellation: boolean;
  /** An ask is open. */
  asking: boolean;
}

/** The line under the wave. */
export function labelOf(phase: Phase, state: VoiceModeState, context: ScreenContext): string {
  if (phase === 'starting') return 'Opening the microphone…';
  if (phase === 'error') return 'Voice mode could not start';
  if (context.asking) return 'Permission needed — say allow, always allow, or deny';
  if (state.muted) return 'Muted — unmute to talk';
  if (state.opening) return 'Opening the microphone…';
  if (phase === 'recording') return 'Recording — press Done when you have finished';
  if (phase === 'listening') return context.pushToTalk ? 'Press Talk to speak' : 'Listening';
  if (phase === 'transcribing') return 'Heard you…';
  if (phase === 'thinking') return 'Thinking…';
  if (context.pushToTalk) return 'Speaking — press Talk to interrupt';
  return context.echoCancellation
    ? 'Speaking — talk to interrupt'
    : 'Speaking — press Stop to talk';
}

export type Tone = 'speaking' | 'thinking' | 'listening' | 'idle';

/** How the wave moves, and whose colour it wears (the person's while listening or idle). */
export function toneOf(phase: Phase, muted: boolean, pushToTalk: boolean): Tone {
  if (phase === 'speaking') return 'speaking';
  if (phase === 'thinking' || phase === 'transcribing') return 'thinking';
  if ((phase === 'recording' || (phase === 'listening' && !pushToTalk)) && !muted) {
    return 'listening';
  }
  return 'idle';
}

/** The line under the label while a turn runs: the call being made, or the model thinking. */
export function workingLine(input: {
  running: boolean;
  asking: boolean;
  phase: Phase;
  activityLine: string | null;
  thinking: boolean;
}): string | null {
  if (!input.running || input.asking) return null;
  if (input.activityLine) return `${input.activityLine}…`;
  if (input.phase !== 'thinking') return null;
  return input.thinking ? 'Thinking it through…' : 'Working…';
}

/** What waits behind the reply, said so the person knows they were heard; null when nothing does. */
export function queuedLine(queued: number, busy: boolean): string | null {
  if (queued <= 0 || !busy) return null;
  return queued === 1
    ? 'Your next message is queued — it goes out when this reply is done.'
    : `${queued} messages are queued — they go out one at a time when this reply is done.`;
}

/** The reply as the panel shows it: its last 700 characters when longer. */
export function replyExcerpt(spokenReply: string): string {
  return spokenReply.length > 700 ? `…${spokenReply.slice(-700)}` : spokenReply;
}

/** The how-to under an empty conversation. */
export function hintOf(input: {
  phase: Phase;
  transcript: string | null;
  spokenReply: string;
  pushToTalk: boolean;
}): string | null {
  if (input.transcript || input.spokenReply || input.phase !== 'listening') return null;
  return input.pushToTalk
    ? 'Press Talk, say what you want, then press Done. Ten seconds of silence ends it too. Press Talk over a reply to interrupt it; while the reply is still being worked out, a take waits its turn.'
    : 'Say something. Pause when you are done, and the reply is read to you. A few words over it interrupt it; while it is still being worked out, what you say waits its turn.';
}

/* --------------------------------------------------------------------- */
/* The microphone                                                        */

/**
 * Without echo cancellation the microphone has no use while the assistant
 * works — it is closed to speech anyway — so its track is released and
 * opened again after, which lets a headset play the reply in stereo.
 * Press-to-talk closes it between takes anyway. Null: leave it as it is.
 */
export function microphoneWhileBusy(input: {
  pushToTalk: boolean;
  echoCancellation: boolean;
  phase: Phase;
  busy: boolean;
  active: boolean;
}): 'stop' | 'start' | null {
  if (input.pushToTalk || input.echoCancellation) return null;
  if (input.phase === 'starting' || input.phase === 'error') return null;
  if (input.busy) return 'stop';
  return input.active ? null : 'start';
}

/**
 * The recorder hears nothing while muted, and — with echo cancellation
 * off and no press-to-talk — while the speaker talks, so its voice does
 * not interrupt itself.
 */
export function recorderMuted(input: {
  muted: boolean;
  pushToTalk: boolean;
  echoCancellation: boolean;
  queueState: SpeechQueueState;
}): boolean {
  return (
    input.muted || (!input.pushToTalk && !input.echoCancellation && input.queueState === 'speaking')
  );
}

/**
 * Press-to-talk's Talk/Done. `end`: a take is open, close and send it.
 * `begin`: open the microphone and a take, cutting a reply being read
 * first (`interrupt`) — but not one still being worked out, nor an ask,
 * which the take answers. Null while the microphone is still opening.
 */
export function takePress(input: {
  opening: boolean;
  taking: boolean;
  responding: boolean;
  asking: boolean;
}): { kind: 'end' } | { kind: 'begin'; interrupt: boolean } | null {
  if (input.opening) return null;
  if (input.taking) return { kind: 'end' };
  return { kind: 'begin', interrupt: !input.asking && input.responding };
}

/** Whether Talk can be pressed. */
export function talkEnabled(phase: Phase, opening: boolean): boolean {
  return phase !== 'starting' && phase !== 'error' && !opening;
}

/** What a key does in the dialog: Escape leaves; Space is Talk/Done unless a control has it. */
export function keyAction(input: {
  key: string;
  pushToTalk: boolean;
  phase: Phase;
  onControl: boolean;
}): 'close' | 'take' | null {
  if (input.key === 'Escape') return 'close';
  if (input.key !== ' ' || !input.pushToTalk) return null;
  if (input.phase === 'starting' || input.phase === 'error' || input.onControl) return null;
  return 'take';
}
