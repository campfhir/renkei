/**
 * A fetched web page as text a model can read — the lightweight half of
 * "look at this URL", beside the browser (which is for pages that need a
 * script run, a login, or a click). No DOM here, the connector-onbase /
 * document-text discipline: a bounded pass of string work over the HTML
 * that keeps what a reader would see and drops what they would skip.
 *
 * What survives: the title; the main content region when the page marks
 * one (`<main>`, `<article>`, `role="main"`), else the body without its
 * navigation, header, footer and asides; headings as `#` lines; list
 * items as `-` lines; table cells separated by `|`; quotes as `>` lines;
 * preformatted blocks as they are; links as `text (absolute URL)` so the
 * model can follow one with another fetch; images as their alt text.
 * Scripts, styles, templates, SVG, iframes and comments never reach the
 * output. The result is capped and says when it was cut.
 */

export interface PageText {
  title: string | null;
  text: string;
  truncated: boolean;
}

export interface PageTextOptions {
  /** Characters of text to keep (the cap is reported, never silent). */
  maxChars: number;
  /** The page's own URL, for resolving relative links. */
  baseUrl?: string;
}

export const PAGE_TEXT_DEFAULT_CHARS = 20_000;
export const PAGE_TEXT_MAX_CHARS = 80_000;

const INERT =
  /<(script|style|noscript|template|svg|iframe|object|embed|canvas|head)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const CHROME = /<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  para: '¶',
  shy: '',
  zwj: '',
  zwnj: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[lower];
    return named === undefined ? match : named;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/** The text of the first `<title>` (or `<h1>`), decoded and squeezed. */
export function pageTitle(html: string): string | null {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const heading = title ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
  if (!heading) return null;
  const text = decodeEntities(heading.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/**
 * The region a reader came for: the largest `<main>` / `<article>` /
 * `role="main"` element when the page marks one and it carries real text,
 * else the body stripped of its chrome, else the whole document.
 */
function contentRegion(html: string): string {
  const candidates: string[] = [];
  for (const match of html.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    candidates.push(match[2] ?? '');
  }
  for (const match of html.matchAll(
    /<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["']?main["']?[^>]*>([\s\S]*?)<\/\1\s*>/gi
  )) {
    candidates.push(match[2] ?? '');
  }
  const best = candidates
    .map((region) => ({ region, length: region.replace(/<[^>]+>/g, '').trim().length }))
    .sort((a, b) => b.length - a.length)[0];
  if (best && best.length >= 200) return best.region;
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
  return body.replace(CHROME, '\n');
}

function resolveHref(href: string, baseUrl: string | undefined): string | null {
  const trimmed = decodeEntities(href).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  try {
    const url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Everything a `<pre>` holds, with tags gone but whitespace kept. */
function preformatted(inner: string): string {
  return decodeEntities(inner.replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
}

export function pageToText(html: string, options: PageTextOptions): PageText {
  const title = pageTitle(html);
  const source = contentRegion(html.replace(COMMENTS, '').replace(INERT, ''));

  // Preformatted blocks keep their whitespace; hold them aside while the
  // rest is linearized, then put them back.
  const holds: string[] = [];
  const marker = (index: number) => `@@renkei-pre-${index}@@`;
  let work = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
    holds.push(preformatted(inner));
    return `\n\n${marker(holds.length - 1)}\n\n`;
  });

  work = work
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
      return `\n\n${'#'.repeat(Number(level))} ${inner.replace(/\s+/g, ' ').trim()}\n\n`;
    })
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (tag: string, inner: string) => {
      const text = inner
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const href = resolveHref(attribute(tag, 'href') ?? '', options.baseUrl);
      if (!href) return inner;
      const shown = decodeEntities(text);
      if (!shown) return ` ${href} `;
      if (shown === href || `${shown}/` === href) return ` ${href} `;
      return `${inner} (${href})`;
    })
    .replace(/<img\b[^>]*>/gi, (tag: string) => {
      const alt = attribute(tag, 'alt')?.trim();
      return alt ? ` [image: ${decodeEntities(alt)}] ` : '';
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner: string) => {
      const lines = inner.replace(/<br\b[^>]*>/gi, '\n').replace(/<\/?(p|div)\b[^>]*>/gi, '\n');
      return `\n\n${lines
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    })
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(
      /<\/?(p|div|section|article|main|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|form|fieldset|figure|figcaption|details|summary|address|tr)\b[^>]*>/gi,
      '\n'
    )
    .replace(/<[^>]+>/g, '');

  const text = tidy(decodeEntities(work))
    .replace(/\n- \n/g, '\n')
    .replace(/ \|\s*$/gm, '')
    .replace(/@@renkei-pre-(\d+)@@/g, (_, index: string) => holds[Number(index)] ?? '')
    .replace(/^\n+|\n+$/g, '');

  const cap = Math.max(1, Math.min(options.maxChars, PAGE_TEXT_MAX_CHARS));
  const truncated = text.length > cap;
  return {
    title,
    text: truncated
      ? `${text.slice(0, cap)}\n\n[cut at ${cap} characters; ${text.length - cap} more on the page]`
      : text,
    truncated,
  };
}

/** True when bytes that arrived without a usable content type read as HTML. */
export function looksLikeHtml(head: string): boolean {
  return (
    /^\s*(<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(head) ||
    /<(html|body|div|p|a|h[1-6])\b/i.test(head.slice(0, 4000))
  );
}
