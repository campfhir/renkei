/**
 * The chart vocabulary behind `sandbox_render_chart` and `chat_write_chart`:
 * what a render request may say, bounded, and refused the same way on both
 * sides of the wire. A chart is Mermaid text the model wrote — a flowchart,
 * a bar or line chart, a Gantt plan, a pie, a sequence diagram — rendered
 * by the sandbox worker's own headless Chromium (apps/worker-sandbox/src/
 * charts.ts) into an SVG, a PNG or a PDF. The model writes text and gets
 * back a file, the platform's rule everywhere: never bytes as arguments.
 *
 * Pure, like the rest of this package: no I/O, no Mermaid, no browser —
 * just the request shape, its limits, and the media types.
 */

/** Longer than any diagram worth drawing in one go; a novel of Mermaid is a mistake. */
export const CHART_SOURCE_MAX_CHARS = 50_000;

/** What a chart can be rendered to, and the media type each answers with. */
export const CHART_MEDIA_TYPES = {
  png: 'image/png',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
} as const;

export type ChartFormat = keyof typeof CHART_MEDIA_TYPES;

export const CHART_FORMATS: readonly ChartFormat[] = ['png', 'svg', 'pdf'];

export const CHART_DEFAULT_FORMAT: ChartFormat = 'png';

/** Mermaid's built-in themes. The source may still set its own with `%%{init: …}%%` or frontmatter. */
export const CHART_THEMES = ['default', 'neutral', 'dark', 'forest', 'base'] as const;

export type ChartTheme = (typeof CHART_THEMES)[number];

export const CHART_DEFAULT_THEME: ChartTheme = 'default';

/** Device pixels per CSS pixel for a PNG: 1 is screen size, 2 is crisp on a retina display or a slide. */
export const CHART_SCALE_MIN = 1;
export const CHART_SCALE_MAX = 4;
export const CHART_DEFAULT_SCALE = 2;

/** Space around the diagram in every rendered file, in CSS pixels. */
export const CHART_PADDING_PX = 16;

/** No single side of a rendered chart is wider or taller than this, in CSS pixels. */
export const CHART_MAX_DIMENSION_PX = 8_000;

/** A render past this is abandoned — the browser is a shared resource. */
export const CHART_RENDER_TIMEOUT_MS = 30_000;

/** Renders in flight at once on one worker; the rest queue. */
export const CHART_MAX_CONCURRENT = 2;

/** A renderer with nothing to do for this long lets its browser exit. */
export const CHART_IDLE_MS = 5 * 60_000;

/** A page background: transparent, or a CSS hex color. Named colors are deliberately not accepted — a hex is unambiguous. */
const BACKGROUND_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const CHART_DEFAULT_BACKGROUND = '#ffffff';

export interface ChartRequest {
  /** The Mermaid diagram text, as written. */
  source: string;
  format: ChartFormat;
  theme: ChartTheme;
  /** `transparent` (PNG and SVG only; a PDF page is always painted) or a `#rrggbb` color. */
  background: string;
  /** PNG only: device pixels per CSS pixel. */
  scale: number;
}

export type ChartRequestRefusal = { ok: false; type: 'bad_request'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isChartFormat(value: unknown): value is ChartFormat {
  return typeof value === 'string' && CHART_FORMATS.some((format) => format === value);
}

export function isChartTheme(value: unknown): value is ChartTheme {
  return typeof value === 'string' && CHART_THEMES.some((theme) => theme === value);
}

/**
 * The request as the wire (or a tool's arguments) carries it, checked and
 * defaulted: the source bounded, the format and theme one of the known
 * words, the background transparent or a hex color, the scale an integer
 * within range. Anything else is refused with what was wrong.
 */
export function parseChartRequest(
  value: unknown
): { ok: true; request: ChartRequest } | ChartRequestRefusal {
  const refuse = (message: string): ChartRequestRefusal => ({
    ok: false,
    type: 'bad_request',
    message,
  });
  if (!isRecord(value)) return refuse('A chart request must be an object.');

  const source = typeof value.source === 'string' ? value.source : '';
  if (!source.trim()) return refuse('source must be the Mermaid diagram text, and not empty.');
  if (source.length > CHART_SOURCE_MAX_CHARS) {
    return refuse(
      `source is ${source.length} characters; a chart is at most ${CHART_SOURCE_MAX_CHARS}.`
    );
  }

  let format: ChartFormat = CHART_DEFAULT_FORMAT;
  if (value.format !== undefined) {
    if (!isChartFormat(value.format)) {
      return refuse(`format must be one of ${CHART_FORMATS.join(', ')}.`);
    }
    format = value.format;
  }

  let theme: ChartTheme = CHART_DEFAULT_THEME;
  if (value.theme !== undefined) {
    if (!isChartTheme(value.theme)) {
      return refuse(`theme must be one of ${CHART_THEMES.join(', ')}.`);
    }
    theme = value.theme;
  }

  let background = CHART_DEFAULT_BACKGROUND;
  if (value.background !== undefined) {
    if (typeof value.background !== 'string') {
      return refuse('background must be "transparent" or a hex color such as #ffffff.');
    }
    const trimmed = value.background.trim().toLowerCase();
    if (trimmed === 'transparent') {
      background = 'transparent';
    } else if (BACKGROUND_PATTERN.test(trimmed)) {
      background = trimmed;
    } else {
      return refuse('background must be "transparent" or a hex color such as #ffffff.');
    }
  }
  // A PDF page has no alpha channel worth the name; paint it.
  if (format === 'pdf' && background === 'transparent') background = CHART_DEFAULT_BACKGROUND;

  let scale = CHART_DEFAULT_SCALE;
  if (value.scale !== undefined) {
    if (
      typeof value.scale !== 'number' ||
      !Number.isInteger(value.scale) ||
      value.scale < CHART_SCALE_MIN ||
      value.scale > CHART_SCALE_MAX
    ) {
      return refuse(`scale must be a whole number from ${CHART_SCALE_MIN} to ${CHART_SCALE_MAX}.`);
    }
    scale = value.scale;
  }

  return { ok: true, request: { source, format, theme, background, scale } };
}

/** The media type a rendered chart is served and staged as. */
export function chartMediaType(format: ChartFormat): string {
  return CHART_MEDIA_TYPES[format];
}

/**
 * The filename a rendered chart is kept under: the caller's name with the
 * format's extension, added when missing and corrected when it names
 * another format (a `.png` asked for as a PDF is `.pdf`); a default when
 * no name was given. The name is a display label only — the worker
 * validates it again before storing anything under it.
 */
export function chartFilename(raw: unknown, format: ChartFormat): string {
  const name = (typeof raw === 'string' ? raw : '').trim();
  const stem = name ? name.replace(/\.(png|svg|pdf|mmd|mermaid)$/i, '') : 'chart';
  return `${stem || 'chart'}.${format}`;
}

/**
 * What the model may say a chart is, in one line — the same list the
 * tool descriptions carry, kept here so both tools say it alike.
 */
export const CHART_KINDS_HINT =
  'flowchart (boxes and arrows), xychart-beta (bar and line charts), pie, gantt, ' +
  'sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, mindmap, timeline, ' +
  'quadrantChart, sankey-beta, gitGraph, block-beta, kanban, radar-beta, treemap-beta';
