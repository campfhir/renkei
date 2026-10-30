/**
 * The one SOAP call the delegate makes for the Salesforce admin connector:
 * the Metadata API's `readMetadata`, which reads a component whole when the
 * Tooling API has no object for it (a custom report type). SOAP carries the
 * session in the envelope, not a header, so the delegate — the only process
 * that holds the token — builds the envelope itself.
 *
 * Narrow on purpose. Only an admin grant, only POST, only the Metadata SOAP
 * endpoint at a pinned version, and only a body that is a single
 * `readMetadata` naming a type and up to ten full names in plain text: no
 * other operation, element or markup gets near the token. Anything else sent
 * to that endpoint is refused, so the token in a body can read and never
 * write — every change still deploys through REST with the token in a
 * header, as before. Pure.
 */

/** The Metadata SOAP endpoint, `/services/Soap/m/68.0`. */
const SOAP_PATH = /^\/services\/Soap\/m\/\d{2,3}\.0\/?$/;

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

export type SoapRequest =
  /** Not a SOAP request: proxied as every other call. */
  | null
  /** A request to the SOAP endpoint that is not one this sends: refused. */
  | { ok: false; message: string }
  /** The envelope for a token (built again on a refresh). */
  | { ok: true; envelope: (token: string) => Buffer };

/**
 * Whether this proxied request is the admin connector's readMetadata, and if
 * so the envelope to send with the session in it. `admin` is whether the
 * grant is the admin connector's; the CRM connector never sends SOAP.
 */
export function salesforceSoapRequest(
  admin: boolean,
  url: URL,
  method: string,
  body: Buffer
): SoapRequest {
  if (!/^\/services\/Soap\//i.test(url.pathname)) return null;
  if (!admin) return { ok: false, message: 'SOAP calls are the admin connector’s alone.' };
  if (!SOAP_PATH.test(url.pathname) || url.search) {
    return { ok: false, message: 'Only the Metadata API’s SOAP endpoint is reachable.' };
  }
  if (method !== 'POST') return { ok: false, message: 'The Metadata SOAP endpoint takes POST.' };
  const read = readMetadataBody(body);
  if (!read) {
    return {
      ok: false,
      message: 'The body must be one readMetadata naming a type and up to ten full names.',
    };
  }
  const { type, names } = read;
  const inner =
    `<met:readMetadata><met:type>${type}</met:type>` +
    names.map((name) => `<met:fullNames>${xmlEscape(name)}</met:fullNames>`).join('') +
    '</met:readMetadata>';
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
