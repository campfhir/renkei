/**
 * A streaming XML scanner for OOXML text extraction.
 *
 * Not a parser: it never builds a document tree. That is the point. OOXML
 * text extraction is a handful of tag-specific rules — take `w:t`, skip the
 * `w:del` subtree, honour `xml:space="preserve"`, break on `w:p` — and a
 * generic parser makes you pay to materialise a tree and then write every one
 * of those rules anyway. A 20MB xlsx inflates to well over 100MB of XML, and
 * turning that into a JS object graph is a memory event for no benefit.
 *
 * It is also immune to the XXE and billion-laughs attacks that DTD-processing
 * parsers keep being patched for, by construction rather than by hardening:
 * `<!DOCTYPE` and `<!ENTITY` are markup it skips, never directives it obeys.
 *
 * The scanner emits events; each format module supplies the rules.
 */

export interface XmlTag {
  /** Qualified name as written, e.g. `w:t`. */
  name: string;
  /** Raw attribute text, unparsed — most tags never need it. */
  attributes: string;
  selfClosing: boolean;
}

export interface XmlHandler {
  onOpen?(tag: XmlTag): void;
  onClose?(name: string): void;
  onText?(text: string): void;
}

/** Named entities that appear in OOXML. Numeric forms are handled generally. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  // Surrogates and out-of-range values would throw; a malformed entity should
  // degrade to nothing, never crash an extraction.
  if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Read one attribute out of a raw attribute string. */
export function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
  if (!match) return null;
  return decodeXmlEntities(match[2] ?? match[3] ?? '');
}

/**
 * Walk `xml`, invoking the handler. Comments, CDATA, processing
 * instructions, DOCTYPE and entity declarations are skipped as markup.
 */
export function scanXml(xml: string, handler: XmlHandler): void {
  let index = 0;
  const length = xml.length;

  while (index < length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) {
      emitText(xml.slice(index));
      return;
    }
    if (lt > index) emitText(xml.slice(index, lt));

    // <!-- comment -->, <![CDATA[...]]>, <!DOCTYPE ...>, <!ENTITY ...>
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const text = xml.slice(lt + 9, end === -1 ? length : end);
      // CDATA is literal — no entity decoding.
      if (text) handler.onText?.(text);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt) || xml.startsWith('<?', lt)) {
      const end = xml.indexOf('>', lt + 2);
      index = end === -1 ? length : end + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) return;
    const inner = xml.slice(lt + 1, gt);
    index = gt + 1;

    if (inner.startsWith('/')) {
      handler.onClose?.(inner.slice(1).trim());
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    const attributes = space === -1 ? '' : body.slice(space + 1);
    if (!name) continue;

    handler.onOpen?.({ name, attributes, selfClosing });
    if (selfClosing) handler.onClose?.(name);
  }

  function emitText(raw: string): void {
    if (!raw) return;
    handler.onText?.(decodeXmlEntities(raw));
  }
}
