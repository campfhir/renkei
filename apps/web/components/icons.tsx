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
  /** Two stacked sheets — the clipboard/copy verb. */
  copy: 'M9 9h10v11H9zM5 15V4h10',
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
  /** A question in a circle — "this card wants information from you". */
  question: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.7 9.4a2.4 2.4 0 1 1 2.8 2.8v1.4M12 17.2h.01',
  bell: 'M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16zM10 22h4',
  /** Vertical kebab — "more actions on this row". Dots via round linecaps. */
  more: 'M12 5.2h.01M12 12h.01M12 18.8h.01',
  /** The same dots laid flat — the horizontal "more" trigger. */
  moreHorizontal: 'M5.2 12h.01M12 12h.01M18.8 12h.01',
  arrowRight: 'M4 12h14M13 6l6 6-6 6',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM15.5 15.5 21 21',
  /** Arrow leaving a box — opens in the connector / a new tab. */
  externalLink: 'M14 4h6v6M20 4l-9 9M20 14v6H4V4h6',
  /** An empty checkbox — "start selecting". */
  checkbox: 'M6 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  /** A ticked checkbox — "select everything". */
  checkboxChecked:
    'M6 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8.5 12l2.5 2.5 4.5-5',
  check: 'M5 12.5l4.5 4.5L19 7',
  /** A ring around a dot — the unread badge, "put it back". */
  unreadDot: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12h.01',
  folder: 'M3 19V5h6l2 3h10v11z',
  folderPlus: 'M3 19V5h6l2 3h10v11zM12 10.5v5M9.5 13h5',
  upload: 'M12 16V4M8 8l4-4 4 4M5 16v4h14v-4',
  /** The chat: a plus for "new", a hamburger for the drawer, and the composer's verbs. */
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h16',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  stop: 'M7 7h10v10H7z',
  paperclip: 'M20 11.5l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
  /** A four-point spark — thinking, and the prompt libraries. */
  sparkle:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  /** A brain — the model's own reasoning (extended thinking). Two lobes and
   *  the fissure only: at 14px the finer sulci of the full glyph smear. */
  brain:
    'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
  /** A wrench — the tools a chat may use. */
  tool: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  /** Plain sheet with a folded corner — the fallback file glyph. */
  file: 'M6 21V3h8l4 4v14zM14 3v4h4',
  fileText: 'M6 21V3h8l4 4v14zM14 3v4h4M9 12h6M9 16h6',
  fileSheet: 'M6 21V3h8l4 4v14zM14 3v4h4M9 11h6v7H9zM9 14.5h6M12 11v7',
  fileImage: 'M6 21V3h8l4 4v14zM14 3v4h4M9.5 11h.01M8 17.5l3-3.5 2 2 1.5-1.5 1.5 2',
};

export function Icon({
  path,
  className,
  strokeWidth = 1.8,
}: {
  path: string;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-4 w-4'}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
