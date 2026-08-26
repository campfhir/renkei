/**
 * Hand-rolled 24-viewBox stroke icons — the repo carries no icon dependency
 * on purpose. Single-path glyphs keep the map flat; add a path here rather
 * than importing a library.
 */

export const ICONS = {
  play: 'M8 5.5v13l11-6.5z',
  pencil: 'M17 3l4 4L8 20l-5 1 1-5zM15 5l4 4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  share: 'M12 3v12M8 7l4-4 4 4M5 11v9h14v-9',
  chevron: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  step: 'M5 5h14v14H5z',
  branch: 'M12 2v6M12 8c0 3-6 2-6 6v6M12 8c0 3 6 2 6 6v6',
  loop: 'M17 4l3 3-3 3M20 7H9a5 5 0 0 0 0 10h2M7 20l-3-3 3-3M4 17h11',
  group: 'M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3',
  terminal: 'M6 21V4M6 4h12l-2.5 4L18 12H6',
  approval: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.5l2.5 2.5 4.5-5.5',
  /** A chip with legs — "this runs as fixed code, not as a model call". */
  chip: 'M8 8h8v8H8zM9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3',
  bell: 'M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16zM10 22h4',
  /** Vertical kebab — "more actions on this row". Dots via round linecaps. */
  more: 'M12 5.2h.01M12 12h.01M12 18.8h.01',
};

export function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-4 w-4'}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
