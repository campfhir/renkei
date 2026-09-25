/**
 * What a voice conversation does when the person makes a sound while the
 * assistant is busy. Sensitivity is the whole question: cut the reply on
 * every sound and a cough, a "mm-hm" or a chair ends every answer; never
 * cut it and the person has to press Stop to get a word in.
 *
 * Three rules, one utterance at a time:
 *
 *  - A reply being read aloud is interrupted only once the person has
 *    said a few words (the recorder's `onSpeechHeld`), never on the
 *    first sound. What they said is then sent as the next message.
 *  - A reply still being worked out — the model thinking, a tool call
 *    running, nothing of the answer read yet — is never interrupted by
 *    talking. What is said queues as the next message instead, and goes
 *    out when the reply is done; the person can add to what they asked
 *    without throwing the work away.
 *  - A sound too short to interrupt, wholly under the assistant's voice
 *    — a "yeah", a cough — is not a message and is dropped, so it
 *    neither cuts the reply nor lands in the chat as text.
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

/** Speech was detected: remember what it started over. */
export function beginUtterance(assistant: AssistantState): Utterance {
  return { overVoice: assistant.responding && !assistant.asking, interrupted: false };
}

/**
 * The person has said a few words: cut the reply if one is being read,
 * and say so on the utterance. Over a reply still being worked out
 * nothing is cut — what is said will queue.
 */
export function holdUtterance(utterance: Utterance, assistant: AssistantState): boolean {
  if (assistant.asking || !assistant.responding) return false;
  utterance.interrupted = true;
  return true;
}

/**
 * The utterance closed: is it a message? Not when it was a sound under
 * the assistant's voice from start to finish that never grew into words.
 */
export function utteranceIsMessage(utterance: Utterance, assistant: AssistantState): boolean {
  if (assistant.asking) return true;
  if (utterance.interrupted) return true;
  return !(utterance.overVoice && assistant.responding);
}
