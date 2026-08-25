/**
 * The Renkei mark, inline.
 *
 * Same path and gradient as `app/icon.svg` — that file is the tab icon and
 * cannot be imported as a component, so the geometry is duplicated here on
 * purpose. Changing the mark means changing both; the alternative is an
 * `<img src="/icon.svg">`, which costs a request and cannot take a size or
 * inherit anything from its surroundings.
 *
 * The gradient id is suffixed per instance. SVG gradient ids are GLOBAL to
 * the document, so two marks on one page (the header and the drawer, which
 * are both mounted at once) would collide: the second definition wins for
 * both, and if either is ever unmounted the surviving mark loses its fill
 * and renders as nothing at all.
 */

import { useId } from 'react';

export default function RenkeiMark({
  className = 'h-6 w-6',
  title,
}: {
  className?: string;
  /** Given only when the mark stands alone; omit beside the wordmark. */
  title?: string;
}) {
  const gradientId = `renkei-mark-${useId()}`;
  return (
    <svg
      viewBox="80 -20 240 240"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0.15" x2="1" y2="0.85">
          <stop offset="0" stopColor="#5FE8E0" />
          <stop offset="0.5" stopColor="#2FC8F0" />
          <stop offset="1" stopColor="#2C7BE5" />
        </linearGradient>
      </defs>
      <path
        d="M100 100C100 40 160 40 200 100C240 160 300 160 300 100C300 40 240 40 200 100C160 160 100 160 100 100Z"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={22}
        strokeLinecap="round"
      />
    </svg>
  );
}
