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

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

/** The document's root element, or null when there is none. */
export function parseXml(xml: string): XmlNode | null {
  const root: XmlNode = { name: '', nil: false, children: [], text: '' };
  const stack: XmlNode[] = [root];
  for (const match of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    const [, cdata, closing, name, attributes, selfClosing, text] = match;
    if (cdata !== undefined) top.text += cdata;
    else if (text !== undefined) top.text += decode(text);
    else if (name === undefined) continue;
    else if (closing) {
      if (stack.length > 1 && localName(stack[stack.length - 1].name) === localName(name)) {
        stack.pop();
      }
    } else {
      const node: XmlNode = {
        name,
        nil: /\bnil\s*=\s*["']true["']/.test(attributes ?? ''),
        children: [],
        text: '',
      };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
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
