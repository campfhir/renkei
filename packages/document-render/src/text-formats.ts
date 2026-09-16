/**
 * What a filename's extension says about the file a caller wants written:
 * kept as the text written, rendered from it (see ./index), or refused
 * with what to write instead. Shared by every caller that turns a model's
 * text into a file — the chat's chat_write_file and the sandbox's
 * sandbox_render_document both resolve a filename through this before
 * deciding whether to render or write the text as is.
 */

/** Extension → media type, for the formats kept as the text written. */
export const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  ics: 'text/calendar',
  svg: 'image/svg+xml',
  sql: 'text/plain',
  log: 'text/plain',
};

/** Media types accepted when the caller names one itself. */
export const WRITABLE_MEDIA_TYPES = new Set([
  ...Object.values(MEDIA_TYPE_BY_EXTENSION),
  'application/x-yaml',
  'text/xml',
  'text/x-markdown',
]);

/** Formats people ask for that cannot be produced from text, with what to do instead. */
export const REFUSED_EXTENSIONS: Record<string, string> = {
  xls: 'write it as .xlsx instead',
  doc: 'write it as .docx instead',
  ppt: 'write it as .pptx instead',
  zip: 'write the files one at a time instead',
  png: 'only text-based and document files can be written',
  jpg: 'only text-based and document files can be written',
  jpeg: 'only text-based and document files can be written',
  gif: 'only text-based and document files can be written',
};

/** More than any caller writes in one go. */
export const RENDER_INPUT_MAX_CHARS = 1_000_000;

export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

export type MediaTypeCheck = { ok: true; mediaType: string } | { ok: false; reason: string };

/**
 * The media type a text file is written as: the caller's, when it names
 * one this can write; else the one its extension implies; else plain
 * text. An extension nothing here can produce is refused with what to
 * write instead. (Rendered formats never reach this — see ./index.)
 */
export function resolveMediaType(filename: string, requested: unknown): MediaTypeCheck {
  const extension = extensionOf(filename);
  if (extension && REFUSED_EXTENSIONS[extension]) {
    return {
      ok: false,
      reason: `.${extension} files cannot be written here: ${REFUSED_EXTENSIONS[extension]}.`,
    };
  }
  if (typeof requested === 'string' && requested.trim()) {
    const mediaType = requested.trim().toLowerCase().split(';')[0]!.trim();
    if (!WRITABLE_MEDIA_TYPES.has(mediaType) && !mediaType.startsWith('text/')) {
      return {
        ok: false,
        reason: `${mediaType} is not a text format this writes; use one of: ${[...WRITABLE_MEDIA_TYPES].sort().join(', ')}.`,
      };
    }
    return { ok: true, mediaType };
  }
  return { ok: true, mediaType: (extension && MEDIA_TYPE_BY_EXTENSION[extension]) || 'text/plain' };
}
