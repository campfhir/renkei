'use client';

import { Icon, ICONS } from '@/components/icons';

/**
 * Removing something, as an icon and a label.
 *
 * The four Remove affordances in this app had four shapes: a red underlined
 * link in a panel footer, plain grey text in a list row, a red text button in
 * a card, and a bare `✕` glyph. Nothing about the first three said "this
 * deletes"; the icon does, before the word is read, and the word says WHAT
 * without making the reader infer it from position.
 *
 * Red is the resting colour, not a hover state. A destructive action that
 * only looks destructive once the pointer is on it has told the person too
 * late — and never at all on a touch screen.
 *
 * `compact` is for repeating list rows, where a full label per row would
 * shout the same thing a dozen times; the icon carries it, and the label
 * moves into the accessible name.
 */
export default function RemoveButton({
  onClick,
  label,
  accessibleLabel,
  compact = false,
  disabled = false,
  className,
}: {
  onClick: () => void;
  /** What is being removed, e.g. "Remove trigger". Visible unless compact. */
  label: string;
  /**
   * A fuller name for screen readers and the tooltip, when the visible label
   * would be ambiguous out of context — twelve rows each saying "Remove" are
   * distinguishable by eye and identical to a screen reader.
   */
  accessibleLabel?: string;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const name = accessibleLabel ?? label;
  const base =
    'inline-flex shrink-0 items-center gap-1.5 rounded-md text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={name}
      title={name}
      className={`${base} ${compact ? 'p-1' : 'px-2 py-1 text-sm font-medium'} ${className ?? ''}`}
    >
      <Icon path={ICONS.trash} />
      {compact ? null : label}
    </button>
  );
}
