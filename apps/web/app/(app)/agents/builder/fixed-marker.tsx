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
 * ONE GLYPH, in the corner, and nothing else. The first version of this
 * also drew a rail down the card's left edge and spelled out the word
 * "fixed" in the badge row — three marks making one claim. On a canvas
 * where every card already carries an ordinal, a kind glyph, a name, a
 * summary line and two or three coloured pills, that was the loudest thing
 * on screen in service of the quietest fact. A glyph a person notices once,
 * asks about once, and thereafter reads at a glance is the whole job.
 *
 * It sits as the last item of the card's header row rather than absolutely
 * positioned, so a long name truncates BEFORE it instead of running
 * underneath it. The tooltip carries the sentence the pill used to spend
 * five characters on, and `aria-label` carries it for a screen reader —
 * which the rail, being colour on an empty span, never did.
 *
 * Truth comes from `nodeUsesModel` in @renkei/agents, which mirrors the
 * engine's dispatch switch. Nothing here decides anything.
 */
export function FixedMark() {
  return (
    <span
      title="Runs as fixed code — no model call"
      aria-label="Runs as fixed code — no model call"
      role="img"
      className="ml-auto shrink-0 text-gray-400 dark:text-gray-600"
    >
      <Icon path={ICONS.chip} className="h-3.5 w-3.5" />
    </span>
  );
}
