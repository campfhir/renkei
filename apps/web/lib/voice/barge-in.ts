/**
 * What a voice conversation does when the person makes a sound while the
 * assistant is busy. Sensitivity is the whole question: cut the reply on
 * every sound and a cough, a "mm-hm" or a chair ends every answer; never
 * cut it and the person has to press Stop to get a word in.
 *
 * Loudness is not the judge. The recorder's speech detector only knows
 * that something is louder than the room; whether it is WORDS is what
 * the speech recognizer says. So a reply being read aloud is cut only
 * once what the person has said so far has been transcribed and reads
 * as words — not nothing (a cough, a door), not a backchannel ("mm-hm",
 * "yeah", "okay": the sounds a listener makes without meaning to take
 * the floor), and not the assistant's own sentence leaking back through
 * the microphone.
 *
 * Three rules, one utterance at a time:
 *
 *  - A reply being read aloud is interrupted only once the person has
 *    said words (the recorder's `onSpeechHeld` hands over the sound so
 *    far, and the transcript of it decides). What they said is then
 *    sent as the next message.
 *  - A reply still being worked out — the model thinking, a tool call
 *    running, nothing of the answer read yet — is never interrupted by
 *    talking. What is said queues as the next message instead, and goes
 *    out when the reply is done; the person can add to what they asked
 *    without throwing the work away.
 *  - A sound under the assistant's voice that never became words — a
 *    "yeah", a cough — is not a message and is dropped, so it neither
 *    cuts the reply nor lands in the chat as text. One that did become
 *    words by the time it closed (a throat cleared, then a sentence)
 *    cuts the reply then, and is sent.
 *
 * A permission ask is outside all three: while the turn is parked
 * behind one, what is said is the answer to it (voice-mode.tsx).
 *
 * Pure, so the rules can be pinned in a test without a microphone.
 */

/** What the assistant is doing, as far as barging in is concerned. */
export interface AssistantState {
  /** Words of the reply are being read aloud right now (or are about to be). */
  responding: boolean;
  /** The turn is waiting on a permission ask; speech answers it. */
  asking: boolean;
}

/** One utterance, from its first sound to its close. */
export interface Utterance {
  /** The reply was being read aloud when the sound began. */
  overVoice: boolean;
  /** This utterance cut the reply short. */
  interrupted: boolean;
}

/**
 * What a listener says without taking the floor. An utterance made only
 * of these is agreement or attention, not an interruption — and, under
 * the assistant's voice, not a message either.
 */
const BACKCHANNEL = new Set([
  'yeah',
  'yep',
  'yup',
  'yes',
  'no',
  'nope',
  'ok',
  'okay',
  'k',
  'mhm',
  'mm',
  'mmm',
  'hm',
  'hmm',
  'hmmm',
  'uh',
  'um',
  'huh',
  'aha',
  'ah',
  'oh',
  'ooh',
  'right',
  'sure',
  'alright',
  'all',
  'fine',
  'good',
  'great',
  'cool',
  'nice',
  'wow',
  'true',
  'exactly',
  'i',
  'see',
  'got',
  'it',
  'thanks',
  'thank',
  'you',
  'please',
  'go',
  'on',
  'ahead',
  'continue',
]);

/** The words of a transcript: lowercase, letters and digits, apostrophes kept, hyphens split. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word.length > 0);
}

/** How many words a snippet must have before it is compared against the reply as a possible echo. */
const ECHO_MIN_WORDS = 3;

/**
 * Whether a transcript is the person talking — words that mean to take
 * the floor. Not when it is empty (the recognizer heard no speech), not
 * when every word is a backchannel, and not when three or more words
 * of it are a run of the reply being read (`spoken`): with echo
 * cancellation imperfect, that is the speaker heard through the
 * microphone, not the person.
 */
export function readsAsWords(text: string, spoken = ''): boolean {
  const words = wordsOf(text);
  if (words.length === 0) return false;
  if (words.every((word) => BACKCHANNEL.has(word))) return false;
  if (words.length >= ECHO_MIN_WORDS && spoken) {
    const phrase = ` ${words.join(' ')} `;
    const reply = ` ${wordsOf(spoken).join(' ')} `;
    if (reply.includes(phrase)) return false;
  }
  return true;
}

/** Speech was detected: remember what it started over. */
export function beginUtterance(assistant: AssistantState): Utterance {
  return { overVoice: assistant.responding && !assistant.asking, interrupted: false };
}

/**
 * Whether the sound so far is worth transcribing to decide an
 * interruption: only over a reply being read, and never during an ask.
 * Over a reply still being worked out nothing is ever cut — what is
 * said will queue — so nothing is asked of the recognizer yet.
 */
export function holdWorthJudging(assistant: AssistantState): boolean {
  return assistant.responding && !assistant.asking;
}

/**
 * The transcript of the sound so far is in: cut the reply if it reads
 * as words and one is still being read, and say so on the utterance.
 */
export function holdUtterance(
  utterance: Utterance,
  assistant: AssistantState,
  heard: string,
  spoken = ''
): boolean {
  if (!holdWorthJudging(assistant)) return false;
  if (!readsAsWords(heard, spoken)) return false;
  utterance.interrupted = true;
  return true;
}

export type CloseDecision = 'send' | 'interrupt' | 'drop';

/**
 * The utterance closed and its transcript is in. `send`: a message, as
 * any utterance is. `interrupt`: it began under the assistant's voice,
 * was not judged words in time, but reads as words now and the reply is
 * still being read — cut it, then send. `drop`: a sound under the voice
 * from start to finish that never became words.
 */
export function closeUtterance(
  utterance: Utterance,
  assistant: AssistantState,
  heard: string,
  spoken = ''
): CloseDecision {
  if (assistant.asking) return 'send';
  if (!utterance.overVoice || utterance.interrupted) return 'send';
  if (!readsAsWords(heard, spoken)) return 'drop';
  if (assistant.responding) {
    utterance.interrupted = true;
    return 'interrupt';
  }
  return 'send';
}
