'use client';

import { Icon, ICONS } from '@/components/icons';

/**
 * The mark that says "running this node calls no model".
 *
 * WHY MARK THE DETERMINISTIC ONES, not the model-calling ones. They are the
 * minority — a group, an approval, an ending, a foreach loop — so the
 * canvas stays quiet and an unmarked card reads as ordinary, which an
 * action step is. And determinism is the claim worth making: the whole
 * point of this pass is that a person can see, without opening anything,
 * where the model's judgement stops and fixed logic begins.
 *
 * Two parts, because either alone is not enough. The rail is a colour-only
 * signal, which disappears at low zoom and for a colourblind reader; the
 * pill carries the same claim as a word. The word is "fixed" rather than
 * "deterministic" — five characters, legible at 10px, and the natural
 * opposite of the "thinks" pill an action step wears when it has no tool.
 *
 * Truth comes from `nodeUsesModel` in @renkei/agents, which mirrors the
 * engine's dispatch switch. Nothing here decides anything.
 */

/**
 * A rail down the card's left inner edge. `inset-y-2` rather than
 * `inset-y-0` so it clears the rounded corners and reads as a rail rather
 * than as a broken border. Neutral gray at 70%: every node kind already
 * has a tint (indigo, amber, slate, sky, green, red) and a coloured rail
 * would fight one of them in either theme.
 *
 * Every node card is already `relative`, so this needs no positioning
 * change at the call site.
 */
export function FixedRail() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-2 left-0 w-1 rounded-full bg-gray-400/70 dark:bg-gray-500/70"
    />
  );
}

/** The badge, first in a card's existing pill row. */
export function FixedPill() {
  return (
    <span
      title="Runs as fixed code — no model call"
      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400"
    >
      <Icon path={ICONS.chip} className="h-3 w-3" />
      fixed
    </span>
  );
}
