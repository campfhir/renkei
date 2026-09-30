/**
 * What a mockup is, as the model asks for it: a title, a format, the
 * source, and the width it was designed at. Pure — the tool that takes
 * the request (lib/chat/mockup-tools.ts), the route that serves it
 * (app/api/.../mockups) and the thread that finds it again in a stored
 * tool call (lib/chat/segment.ts) all read it through here, so a call the
 * tool accepted is always one the thread can draw.
 */

export const MOCKUP_TOOL = 'chat_show_mockup';

export const MOCKUP_FORMATS = ['react', 'html', 'svg'] as const;
export type MockupFormat = (typeof MOCKUP_FORMATS)[number];

export const MOCKUP_SOURCE_MAX_CHARS = 80_000;
export const MOCKUP_CSS_MAX_CHARS = 30_000;
export const MOCKUP_TITLE_MAX_CHARS = 120;

export const MOCKUP_WIDTH_MIN = 240;
export const MOCKUP_WIDTH_MAX = 1920;
export const MOCKUP_WIDTH_DEFAULT = 1024;
export const MOCKUP_HEIGHT_MIN = 120;
export const MOCKUP_HEIGHT_MAX = 4000;

export interface MockupRequest {
  title: string;
  format: MockupFormat;
  source: string;
  /** Extra CSS, after the reset; '' when none. Tailwind directives work in react and html. */
  css: string;
  /** The viewport width the design is laid out at, in CSS pixels. */
  width: number;
  /** A fixed viewport height, or null to let the page be as tall as its content. */
  height: number | null;
}

export type MockupParse = { ok: true; request: MockupRequest } | { ok: false; message: string };

function isFormat(value: unknown): value is MockupFormat {
  return MOCKUP_FORMATS.some((format) => format === value);
}

function integerIn(value: unknown, min: number, max: number): number | null | 'bad' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'bad';
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseMockupRequest(input: unknown): MockupParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'The mockup request must be an object.' };
  }
  const { title, format, source, css, width, height }: Record<string, unknown> = Object.fromEntries(
    Object.entries(input)
  );
  if (!isFormat(format)) {
    return { ok: false, message: `format must be one of: ${MOCKUP_FORMATS.join(', ')}.` };
  }
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, message: 'source is required: the mockup’s code.' };
  }
  if (source.length > MOCKUP_SOURCE_MAX_CHARS) {
    return {
      ok: false,
      message: `source is ${source.length} characters; the most a mockup may be is ${MOCKUP_SOURCE_MAX_CHARS}. Trim it to the one screen that matters.`,
    };
  }
  if (css !== undefined && typeof css !== 'string') {
    return { ok: false, message: 'css must be text.' };
  }
  if (typeof css === 'string' && css.length > MOCKUP_CSS_MAX_CHARS) {
    return { ok: false, message: `css may be at most ${MOCKUP_CSS_MAX_CHARS} characters.` };
  }
  if (format === 'svg' && !/<svg[\s>]/i.test(source)) {
    return { ok: false, message: 'An svg mockup’s source must be an <svg> element.' };
  }
  const wide = integerIn(width, MOCKUP_WIDTH_MIN, MOCKUP_WIDTH_MAX);
  const tall = integerIn(height, MOCKUP_HEIGHT_MIN, MOCKUP_HEIGHT_MAX);
  if (wide === 'bad' || tall === 'bad') {
    return { ok: false, message: 'width and height must be numbers of pixels.' };
  }
  const named = typeof title === 'string' ? title.trim().slice(0, MOCKUP_TITLE_MAX_CHARS) : '';
  return {
    ok: true,
    request: {
      title: named || 'Mockup',
      format,
      source,
      css: typeof css === 'string' ? css : '',
      width: wide ?? MOCKUP_WIDTH_DEFAULT,
      height: tall,
    },
  };
}
