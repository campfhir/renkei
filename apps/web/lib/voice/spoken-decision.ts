/**
 * A permission ask answered by voice. The card on screen has three
 * buttons; a person in a voice conversation says one of them instead.
 * "Always allow" must win over "allow" (it contains it), and a "no" that
 * is really "no, always allow it" is rare enough that the plain words
 * decide: deny wins over yes when both are said, because letting
 * something act on a misheard yes is the worse mistake.
 */

import type { ToolPermissionDecision } from '@/lib/chat/views';

const ALWAYS = /\b(always allow|allow always|allow it always|always)\b/i;
const DENY = /\b(deny|denied|no|nope|don't|do not|dont|stop|cancel|reject|refuse)\b/i;
const ONCE = /\b(allow|allowed|yes|yeah|yep|ok|okay|sure|go ahead|approve|approved|do it|fine)\b/i;

/** What was said, as a decision — or null when it was none of the three. */
export function spokenDecision(text: string): ToolPermissionDecision | null {
  const said = text.trim();
  if (!said) return null;
  if (ALWAYS.test(said)) return DENY.test(said.replace(ALWAYS, '')) ? 'deny' : 'always';
  if (DENY.test(said)) return 'deny';
  if (ONCE.test(said)) return 'once';
  return null;
}
