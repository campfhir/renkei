/**
 * The SOAP calls the delegate makes for the Salesforce admin connector, all
 * of them reads of the Metadata API: `readMetadata`, which reads a component
 * whole when the Tooling API has no object for it (a custom report type);
 * and `retrieve` with `checkRetrieveStatus`, which hand back named
 * components as the zip a code project's checkout turns into source
 * (apps/web/lib/code/salesforce-pull.ts). SOAP carries the session in the
 * envelope, not a header, so the delegate — the only process that holds the
 * token — builds the envelope itself.
 *
 * Narrow on purpose. Only an admin grant, only POST, only the Metadata SOAP
 * endpoint at a pinned version, and only a body that is one of those three
 * in the short form below — names in plain text, no other operation,
 * element or markup gets near the token. Anything else sent to that
 * endpoint is refused, so the token in a body can read and never write —
 * every change still deploys through REST with the token in a header, as
 * before. Pure.
 */

/** The Metadata SOAP endpoint, `/services/Soap/m/68.0`; the version is what a retrieve asks for. */
const SOAP_PATH = /^\/services\/Soap\/m\/(\d{2,3}\.0)\/?$/;

const METADATA_NAMESPACE = 'http://soap.sforce.com/2006/04/metadata';

/**
 * The body a caller sends: one readMetadata in the metadata namespace,
 * holding a type and its full names — names a deploy could take, so no
 * markup, quotes or entities. Read piece by piece, never with one pattern
 * over the whole body: the opening and closing tags are fixed strings, and
 * each piece is optional whitespace then a literal `<`, which no quantifier
 * can share, so reading it is linear in the body however it is crafted.
 */
const OPEN = `<readMetadata xmlns="${METADATA_NAMESPACE}">`;
const CLOSE = '</readMetadata>';
const TYPE = /^\s*<type>([A-Za-z][A-Za-z0-9]{0,79})<\/type>/;
const FULL_NAME = /^\s*<fullNames>([A-Za-z0-9_.$/ -]{1,255})<\/fullNames>/;
const MAX_NAMES = 10;
/** Ten names of 255 characters and their tags fit with room to spare. */
const MAX_BODY_BYTES = 8_192;

/** The type and full names of a readMetadata body, or null when it is anything else. */
function readMetadataBody(body: Buffer): { type: string; names: string[] } | null {
  if (body.byteLength > MAX_BODY_BYTES) return null;
  const text = body.toString('utf8').trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return null;
  let rest = text.slice(OPEN.length, text.length - CLOSE.length);
  const type = TYPE.exec(rest);
  if (!type) return null;
  rest = rest.slice(type[0].length);
  const names: string[] = [];
  for (let name = FULL_NAME.exec(rest); name; name = FULL_NAME.exec(rest)) {
    if (names.length === MAX_NAMES) return null;
    names.push(name[1].trim());
    rest = rest.slice(name[0].length);
  }
  return names.length > 0 && rest.trim() === '' ? { type: type[1], names } : null;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A retrieve as a caller sends it: the manifest alone, each `<types>` a
 * metadata type's name and the members wanted of it (`*` for all of a type
 * that takes it; a layout's name carries spaces and percent-escapes). The
 * delegate adds the rest — the API version, one unpackaged package. Read
 * piece by piece like readMetadata, for the same reason.
 */
const RETRIEVE_OPEN = `<retrieve xmlns="${METADATA_NAMESPACE}">`;
const RETRIEVE_CLOSE = '</retrieve>';
const TYPES_OPEN = /^\s*<types>/;
const TYPES_CLOSE = /^\s*<\/types>/;
const TYPE_NAME = /^\s*<name>([A-Za-z][A-Za-z0-9]{0,79})<\/name>/;
const MEMBER = /^\s*<members>([A-Za-z0-9_.$%/* -]{1,255})<\/members>/;
const MAX_TYPES = 100;
const MAX_MEMBERS = 5_000;
const MAX_RETRIEVE_BYTES = 512 * 1_024;

interface RetrieveTypes {
  name: string;
  members: string[];
}

/** The manifest of a retrieve body, or null when it is anything else. */
function retrieveBody(body: Buffer): RetrieveTypes[] | null {
  if (body.byteLength > MAX_RETRIEVE_BYTES) return null;
  const text = body.toString('utf8').trim();
  if (!text.startsWith(RETRIEVE_OPEN) || !text.endsWith(RETRIEVE_CLOSE)) return null;
  let rest = text.slice(RETRIEVE_OPEN.length, text.length - RETRIEVE_CLOSE.length);
  const types: RetrieveTypes[] = [];
  let count = 0;
  for (let open = TYPES_OPEN.exec(rest); open; open = TYPES_OPEN.exec(rest)) {
    if (types.length === MAX_TYPES) return null;
    rest = rest.slice(open[0].length);
    const name = TYPE_NAME.exec(rest);
    if (!name) return null;
    rest = rest.slice(name[0].length);
    const members: string[] = [];
    for (let member = MEMBER.exec(rest); member; member = MEMBER.exec(rest)) {
      count += 1;
      if (count > MAX_MEMBERS) return null;
      members.push(member[1].trim());
      rest = rest.slice(member[0].length);
    }
    const close = TYPES_CLOSE.exec(rest);
    if (!close || members.length === 0) return null;
    rest = rest.slice(close[0].length);
    types.push({ name: name[1], members });
  }
  return types.length > 0 && rest.trim() === '' ? types : null;
}

/** Asking how a retrieve is doing: its id alone; the delegate asks for the zip with it. */
const CHECK_RETRIEVE = new RegExp(
  `^<checkRetrieveStatus xmlns="${METADATA_NAMESPACE}">\\s*<asyncProcessId>([A-Za-z0-9]{15,18})</asyncProcessId>\\s*</checkRetrieveStatus>$`
);

/** The retrieve's id of a checkRetrieveStatus body, or null when it is anything else. */
function checkRetrieveBody(body: Buffer): string | null {
  if (body.byteLength > 512) return null;
  return CHECK_RETRIEVE.exec(body.toString('utf8').trim())?.[1] ?? null;
}

/** The operation a body asks for, as the element that goes in the envelope; null when it is none of the three. */
function operationOf(body: Buffer, version: string): string | null {
  const read = readMetadataBody(body);
  if (read) {
    return (
      `<met:readMetadata><met:type>${read.type}</met:type>` +
      read.names.map((name) => `<met:fullNames>${xmlEscape(name)}</met:fullNames>`).join('') +
      '</met:readMetadata>'
    );
  }
  const types = retrieveBody(body);
  if (types) {
    const manifest = types
      .map(
        ({ name, members }) =>
          '<met:types>' +
          members.map((member) => `<met:members>${xmlEscape(member)}</met:members>`).join('') +
          `<met:name>${name}</met:name></met:types>`
      )
      .join('');
    return (
      `<met:retrieve><met:retrieveRequest><met:apiVersion>${version}</met:apiVersion>` +
      '<met:singlePackage>true</met:singlePackage>' +
      `<met:unpackaged>${manifest}<met:version>${version}</met:version></met:unpackaged>` +
      '</met:retrieveRequest></met:retrieve>'
    );
  }
  const id = checkRetrieveBody(body);
  if (id) {
    return (
      `<met:checkRetrieveStatus><met:asyncProcessId>${id}</met:asyncProcessId>` +
      '<met:includeZip>true</met:includeZip></met:checkRetrieveStatus>'
    );
  }
  return null;
}

export type SoapRequest =
  /** Not a SOAP request: proxied as every other call. */
  | null
  /** A request to the SOAP endpoint that is not one this sends: refused. */
  | { ok: false; message: string }
  /** The envelope for a token (built again on a refresh). */
  | { ok: true; envelope: (token: string) => Buffer };

/**
 * Whether this proxied request is one of the admin connector's Metadata API
 * reads, and if so the envelope to send with the session in it. `admin` is
 * whether the grant is the admin connector's; the CRM connector never sends
 * SOAP.
 */
export function salesforceSoapRequest(
  admin: boolean,
  url: URL,
  method: string,
  body: Buffer
): SoapRequest {
  if (!/^\/services\/Soap\//i.test(url.pathname)) return null;
  if (!admin) return { ok: false, message: 'SOAP calls are the admin connector’s alone.' };
  const version = SOAP_PATH.exec(url.pathname)?.[1];
  if (!version || url.search) {
    return { ok: false, message: 'Only the Metadata API’s SOAP endpoint is reachable.' };
  }
  if (method !== 'POST') return { ok: false, message: 'The Metadata SOAP endpoint takes POST.' };
  const inner = operationOf(body, version);
  if (!inner) {
    return {
      ok: false,
      message:
        'The body must be one readMetadata naming a type and up to ten full names, one retrieve naming types and their members, or one checkRetrieveStatus naming a retrieve.',
    };
  }
  return {
    ok: true,
    envelope: (token) =>
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="${METADATA_NAMESPACE}">` +
          `<soapenv:Header><met:SessionHeader><met:sessionId>${xmlEscape(token)}</met:sessionId></met:SessionHeader></soapenv:Header>` +
          `<soapenv:Body>${inner}</soapenv:Body>` +
          '</soapenv:Envelope>',
        'utf8'
      ),
  };
}

/** Whether a SOAP answer is Salesforce saying the session expired (a fault, HTTP 500, not a 401). */
export function isExpiredSession(status: number, text: string): boolean {
  return status === 500 && /INVALID_SESSION_ID/.test(text);
}
