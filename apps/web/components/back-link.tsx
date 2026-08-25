import Link from 'next/link';
import { Icon, ICONS } from '@/components/icons';

/**
 * Going back, as a chevron sitting in the title.
 *
 * Every place that had a "back" had invented its own: `← “Agent name”` above
 * the heading on one page, `← Runs` on another, a chevron button beside the
 * title on a third, `← Sites` as small grey text inside a panel. Same
 * gesture, four shapes in three positions, so the eye had to find it again
 * everywhere.
 *
 * The chevron alone carries the meaning; WHERE you are going is the place you
 * just came from, which the reader already knows. Naming it in visible text
 * cost a line above the heading and pushed the title down the page. It is
 * still named in the tooltip and to screen readers, where the redundancy is
 * free and the ambiguity would be real.
 *
 * Meant to be composed INTO the title row, so the chevron is vertically
 * centred on the heading it belongs to:
 *
 *     <div className="mb-4 flex items-center gap-2">
 *       <BackLink href={…} label="All agents" />
 *       <h1 className="min-w-0 truncate text-xl font-bold">{name}</h1>
 *     </div>
 */

const CHEVRON_CLASS =
  'shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200';

/** "All agents" → "Back to all agents", without lowercasing a quoted name. */
function tooltip(label: string): string {
  const first = label.charAt(0);
  const rest = label.slice(1);
  return first === first.toUpperCase() && first !== first.toLowerCase()
    ? `Back to ${first.toLowerCase()}${rest}`
    : `Back to ${label}`;
}

export default function BackLink({
  href,
  label,
}: {
  href: string;
  /** Where this goes, e.g. "All agents" — for the tooltip and screen readers. */
  label: string;
}) {
  return (
    <Link href={href} aria-label={label} title={tooltip(label)} className={CHEVRON_CLASS}>
      <Icon path={ICONS.chevronLeft} />
    </Link>
  );
}

/**
 * The same affordance where "back" is not a navigation.
 *
 * Some backs step out of a local state — a drill-down inside a panel, a
 * selected node in the builder — and are buttons, not links. They must still
 * LOOK identical, because to the person clicking there is no difference.
 */
export function BackButton({
  onClick,
  label,
  className,
}: {
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={tooltip(label)}
      className={className ? `${CHEVRON_CLASS} ${className}` : CHEVRON_CLASS}
    >
      <Icon path={ICONS.chevronLeft} />
    </button>
  );
}
