/**
 * Just enough XML to read the Metadata API's SOAP answers: elements, text,
 * CDATA, entities and `xsi:nil`, read into the JSON shape the Tooling API's
 * `Metadata` field uses — an element holding only text is a string, one
 * holding elements an object keyed by their local names (a repeated name an
 * array), a nil element null — so metadata-xml.ts writes it back the same
 * way. Attributes otherwise, processing instructions and comments are
 * dropped. Not a general parser; the SOAP answers it reads are Salesforce's
 * own, well-formed. Pure.
 */

import { isRecord } from '@renkei/guards';

type Json = Record<string, unknown>;

interface XmlNode {
  name: string;
  nil: boolean;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

const NAME = /^[A-Za-z_][\w:.-]*/;

/**
 * The document's root element, or null when there is none. Read with a
 * scanner, not a pattern over the whole text: each step finds the next `<`
 * and then its closer with indexOf, and stops reading at a construct that
 * never closes, so a crafted answer costs time in proportion to its length.
 */
export function parseXml(xml: string): XmlNode | null {
  const root: XmlNode = { name: '', nil: false, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1];
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf('<', at);
    if (open === -1) {
      top().text += decode(xml.slice(at));
      break;
    }
    if (open > at) top().text += decode(xml.slice(at, open));
    // CDATA keeps its text as is; comments, processing instructions and
    // declarations are skipped. One that never closes ends the document.
    const skip = (opener: string, closer: string): number | null => {
      if (!xml.startsWith(opener, open)) return null;
      const close = xml.indexOf(closer, open + opener.length);
      return close === -1 ? -1 : close;
    };
    const cdata = skip('<![CDATA[', ']]>');
    if (cdata !== null) {
      if (cdata === -1) break;
      top().text += xml.slice(open + 9, cdata);
      at = cdata + 3;
      continue;
    }
    const comment = skip('<!--', '-->');
    const instruction = comment === null ? skip('<?', '?>') : null;
    const declaration = comment === null && instruction === null ? skip('<!', '>') : null;
    const skipped = comment ?? instruction ?? declaration;
    if (skipped !== null) {
      if (skipped === -1) break;
      at = skipped + (comment !== null ? 3 : instruction !== null ? 2 : 1);
      continue;
    }
    const close = xml.indexOf('>', open);
    if (close === -1) break;
    at = close + 1;
    const inside = xml.slice(open + 1, close);
    const closing = inside.startsWith('/');
    const name = NAME.exec(closing ? inside.slice(1) : inside)?.[0];
    if (!name) continue;
    if (closing) {
      if (stack.length > 1 && localName(top().name) === localName(name)) stack.pop();
      continue;
    }
    const attributes = inside.slice(name.length);
    const node: XmlNode = {
      name,
      nil: /\bnil\s*=\s*["']true["']/.test(attributes),
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!attributes.trimEnd().endsWith('/')) stack.push(node);
  }
  return root.children[0] ?? null;
}

/** An element as the Tooling API's JSON would have it. */
export function xmlToJson(node: XmlNode): unknown {
  if (node.nil) return null;
  if (node.children.length === 0) return node.text.trim();
  const out: Json = {};
  for (const child of node.children) {
    const key = localName(child.name);
    const value = xmlToJson(child);
    const held = out[key];
    if (held === undefined) out[key] = value;
    else if (Array.isArray(held)) held.push(value);
    else out[key] = [held, value];
  }
  return out;
}

/** The child elements of `node` with this local name. */
function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => localName(child.name) === name);
}

/**
 * The records of a readMetadata answer (`Envelope › Body ›
 * readMetadataResponse › result › records`), as JSON; a name that names
 * nothing comes back as a record without a `fullName`, or nil — null here.
 * A SOAP fault is returned as its message.
 */
export function readMetadataRecords(xml: string): Array<Json | null> | { fault: string } {
  const envelope = parseXml(xml);
  const body = envelope ? childrenNamed(envelope, 'Body')[0] : undefined;
  if (!body) return { fault: 'The answer was not a SOAP envelope.' };
  const fault = childrenNamed(body, 'Fault')[0];
  if (fault) {
    const message = childrenNamed(fault, 'faultstring')[0]?.text.trim();
    return { fault: message || 'Salesforce answered with a SOAP fault.' };
  }
  const result = childrenNamed(body, 'readMetadataResponse')[0]
    ? childrenNamed(childrenNamed(body, 'readMetadataResponse')[0], 'result')[0]
    : undefined;
  if (!result) return { fault: 'The answer held no readMetadata result.' };
  return childrenNamed(result, 'records').map((record) => {
    const value = xmlToJson(record);
    return isRecord(value) && 'fullName' in value ? value : null;
  });
}
