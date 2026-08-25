/**
 * Invite bodies — the calendar half of the sanitizer.
 *
 * An invite is not an email, and cleaning it as one leaves the single worst
 * thing in it behind. Mail's noise is per-message (a banner, a quoted chain,
 * a signature); an invite's noise is the CONFERENCING BLOCK, and that block
 * is byte-identical across every meeting in the tenant:
 *
 *     ________________________________________________________________
 *     Microsoft Teams  Need help?
 *     Join the meeting now
 *     Meeting ID: 123 456 789 012        <- worth keeping
 *     Passcode: aB3xY9                   <- worth keeping
 *     Dial in by phone
 *     +1 323-555-0100,,472910384#        <- worth keeping
 *     Find a local number | Reset dial-in PIN
 *     For organizers: Meeting options | Reset dial-in PIN
 *
 * Six useful tokens wrapped in forty lines of instructions. Embedded as-is,
 * every invite in the org looks like every other invite — the boilerplate
 * dominates the vector, so "the vendor call about the pharmacy migration"
 * retrieves a hundred meetings that merely share Teams. That is a retrieval
 * bug that no amount of better prompting fixes downstream.
 *
 * So the rule here is subtractive but narrow: drop a line only when it is
 * instructional chrome, and never when it carries an id, a passcode, a phone
 * number or a link. Deleting a join URL to tidy a chunk would be a far worse
 * outcome than leaving chrome in, so every rule below fails toward keeping.
 *
 * Kept separate from `generic.ts` on purpose: mail rules and invite rules
 * drift for different reasons (a Teams UI change; a new mail gateway), and
 * they are maintained by whoever notices the mess in their own surface.
 */

import { cleanHumanMail } from './generic';

/**
 * Instructional chrome from the conferencing providers we actually see.
 *
 * Matched against a whole trimmed line, so a sentence that merely mentions
 * "meeting options" inside a human paragraph is not touched.
 */
const CHROME_LINES: readonly RegExp[] = [
  // Teams
  /^microsoft teams$/i,
  /^need help\??$/i,
  /^join the meeting now$/i,
  /^join on your computer,?.*$/i,
  /^click here to join the meeting$/i,
  /^download teams\b.*$/i,
  /^join on the web( instead)?$/i,
  /^dial in by phone$/i,
  /^find a local number.*$/i,
  /^reset dial-?in pin.*$/i,
  /^for organi[sz]ers:?.*$/i,
  /^meeting options\b.*$/i,
  /^or call in \(audio only\)$/i,
  /^learn more\b.*$/i,
  // Zoom
  /^one tap mobile$/i,
  /^dial by your location$/i,
  /^find your local number:?$/i,
  /^join zoom meeting$/i,
  // Webex
  /^join meeting$/i,
  /^more ways to join:?$/i,
  /^join from the meeting link$/i,
  /^join by meeting number$/i,
  /^tap to join from a mobile device.*$/i,
  /^join by phone$/i,
  /^global call-?in numbers.*$/i,
  /^join from a video system or application$/i,
  /^need help\? go to\b.*$/i,
  // Generic separators the providers draw around the block.
  /^[_\-=*~]{6,}$/,
];

/** Something a person would be annoyed to lose. */
const LOAD_BEARING = [
  /https?:\/\//i,
  // An id, PIN, passcode or phone number — any run of digits long enough to
  // be one, including the spaced groups Teams prints.
  /\d(?:[\s-]?\d){4,}/,
  // The word plus an actual value. Bare "Reset dial-in PIN" is an
  // instruction, not a credential, and matching on the noun alone kept
  // every line of the chrome that happens to name one.
  /\b(?:passcode|password|pin|meeting id|access code|conference id)\b\s*[:#-]?\s*[A-Za-z0-9]{4,}/i,
];

function isLoadBearing(line: string): boolean {
  return LOAD_BEARING.some((pattern) => pattern.test(line));
}

function isChrome(line: string): boolean {
  return CHROME_LINES.some((pattern) => pattern.test(line));
}

/**
 * Drop conferencing chrome, keep the coordinates.
 *
 * Line-oriented rather than block-oriented because providers disagree about
 * where their block starts and none of them mark where it ends — a
 * start-to-end matcher would either stop early and leave half the chrome, or
 * run long and eat the agenda underneath it.
 */
export function stripConferencingBoilerplate(text: string): string {
  const kept: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line && isChrome(line) && !isLoadBearing(line)) continue;
    kept.push(raw);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * An invite body reduced to what a person would have written.
 *
 * Runs the shared mail cleaning first — invites carry external-sender
 * banners, legal footers and forwarded chains exactly as mail does, and
 * those rules are already tested there — then removes the conferencing
 * block that only calendars have.
 */
export function cleanInviteBody(text: string, bannerPatterns?: readonly string[]): string {
  return stripConferencingBoilerplate(cleanHumanMail(text, bannerPatterns));
}
