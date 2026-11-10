/**
 * Testing a connector's connection the way the Administrator's "Test
 * Connection" / "Test Read" / "Test Write" buttons do: Mirth's connector
 * services (`POST /connectors/<type>/_test…`) take the connector's own
 * properties and try them from the Mirth server — open the TCP socket,
 * reach the HTTP or SOAP endpoint, read or write the directory over
 * file/FTP/SFTP/SMB/S3 — and answer SUCCESS, TIME_OUT or FAILURE with a
 * message. Only the sender types with a remote end and the file reader
 * have one; a listener, a database, a channel or JavaScript writer, JMS,
 * DICOM and SMTP do not, and the tool says so by name.
 *
 * The properties travel as the XML the channel definition holds, because
 * that is exactly the document the servlet deserialises: the connector's
 * `<properties class="com.mirth…TcpDispatcherProperties" version="…">`
 * element, re-rooted under its class name. Reading the channel as XML and
 * cutting that element out keeps every nested setting (plugin properties,
 * transmission mode, queue settings, scheme properties) byte for byte,
 * where a JSON round trip would have to rebuild XStream's dialect. The
 * scan is a balanced-tag cut, not a parser: a Mirth channel document is
 * machine-written, each connector's `<properties>` precedes its
 * transformer, and no connector or properties element nests inside
 * another of its own tag.
 *
 * Pure: index.ts fetches the channel and posts the test; this file cuts,
 * maps and phrases.
 */

import { isRecord } from '@renkei/guards';

/** One connector as the channel XML describes it, with its properties element intact. */
export interface ConnectorXml {
  metaDataId: number;
  role: 'source' | 'destination';
  name: string;
  transportName: string;
  enabled: boolean;
  /** The Java class of the properties element (its `class` attribute). */
  propertiesClass: string;
  /** The properties element's other attributes, verbatim (` version="4.5.2"`). */
  propertiesAttributes: string;
  /** The properties element's inner XML, verbatim. */
  propertiesXml: string;
}

export interface ChannelConnectors {
  id: string;
  name: string;
  connectors: ConnectorXml[];
}

/** What to post to Mirth to test one connector. */
export interface ConnectionTestPlan {
  /** The connector-service route, relative to /api. */
  path: string;
  /** What Mirth is asked to do, for the line that reports it ("open a TCP connection to …"). */
  attempt: string;
  body: string;
  contentType: 'application/xml' | 'text/plain';
}

export interface ConnectionTestResult {
  type: 'SUCCESS' | 'TIME_OUT' | 'FAILURE' | 'UNKNOWN';
  message: string;
  connectionInfo: string;
}

interface Cut {
  /** The opening tag's attribute text, trimmed (`class="…" version="…"`). */
  attributes: string;
  inner: string;
  /** Offset of the opening tag. */
  start: number;
  /** Offset just past the closing tag. */
  end: number;
}

/**
 * The first `<tag …>…</tag>` element at or after `from`, with nested
 * same-tag elements balanced; a self-closing `<tag …/>` has empty inner.
 */
function cut(xml: string, tag: string, from = 0): Cut | null {
  const token = new RegExp(`<(/?)${tag}(?=[\\s/>])([^>]*)>`, 'g');
  token.lastIndex = from;
  const start = token.exec(xml);
  if (!start || start[1] === '/') return null;
  const opening = start[2].trim();
  if (opening.endsWith('/')) {
    return {
      attributes: opening.slice(0, -1).trim(),
      inner: '',
      start: start.index,
      end: token.lastIndex,
    };
  }
  const innerStart = token.lastIndex;
  let depth = 1;
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) {
        return {
          attributes: opening,
          inner: xml.slice(innerStart, match.index),
          start: start.index,
          end: token.lastIndex,
        };
      }
    } else if (!match[2].trim().endsWith('/')) {
      depth += 1;
    }
  }
  return null;
}

/** The text of the first `<tag>` directly in `xml` (not descending for one), entity-decoded. */
function textOfTag(xml: string, tag: string): string {
  const found = cut(xml, tag);
  return found ? unescapeXml(found.inner.trim()) : '';
}

/** Unescape the five XML entities (Mirth escapes names and addresses with them). */
export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributeOf(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return match ? unescapeXml(match[1]) : '';
}

function withoutAttribute(attributes: string, name: string): string {
  return attributes
    .replace(new RegExp(`(?:^|\\s)${name}="[^"]*"`), '')
    .replace(/\s+/g, ' ')
    .trim();
}

function connectorOf(role: 'source' | 'destination', inner: string): ConnectorXml | null {
  const properties = cut(inner, 'properties');
  if (!properties) return null;
  // The connector's own fields, with its properties (which hold names,
  // enabled flags and ids of their own) out of the way.
  const outside = inner.slice(0, properties.start) + inner.slice(properties.end);
  const metaDataId = Number(textOfTag(outside, 'metaDataId'));
  return {
    metaDataId: role === 'source' ? 0 : Number.isFinite(metaDataId) ? metaDataId : NaN,
    role,
    name: textOfTag(outside, 'name'),
    transportName: textOfTag(outside, 'transportName'),
    enabled: textOfTag(outside, 'enabled') !== 'false',
    propertiesClass: attributeOf(properties.attributes, 'class'),
    propertiesAttributes: withoutAttribute(properties.attributes, 'class'),
    propertiesXml: properties.inner,
  };
}

/**
 * The channel's id, name and connectors from the XML `GET /channels/{id}`
 * answers (the Administrator's export). Null when the document is not a
 * channel.
 */
export function channelConnectorsOf(channelXml: string): ChannelConnectors | null {
  const channel = cut(channelXml, 'channel');
  if (!channel) return null;
  const id = textOfTag(channel.inner, 'id');
  if (!id) return null;
  const connectors: ConnectorXml[] = [];
  const source = cut(channel.inner, 'sourceConnector');
  const sourceConnector = source && connectorOf('source', source.inner);
  if (sourceConnector) connectors.push(sourceConnector);
  const destinations = cut(channel.inner, 'destinationConnectors');
  let from = 0;
  while (destinations) {
    const next = cut(destinations.inner, 'connector', from);
    if (!next) break;
    from = next.end;
    const connector = connectorOf('destination', next.inner);
    if (connector && Number.isFinite(connector.metaDataId)) connectors.push(connector);
  }
  return { id, name: textOfTag(channel.inner, 'name'), connectors };
}

/** The value of a property directly under the connector's properties element. */
function property(connector: ConnectorXml, tag: string): string {
  return textOfTag(connector.propertiesXml, tag);
}

/** The connector's properties element re-rooted under its class, as the connector services take it. */
function propertiesDocument(connector: ConnectorXml): string {
  const root = connector.propertiesClass;
  const attributes = connector.propertiesAttributes ? ` ${connector.propertiesAttributes}` : '';
  return `<${root}${attributes}>${connector.propertiesXml}</${root}>`;
}

function fileTarget(connector: ConnectorXml): string {
  const scheme = property(connector, 'scheme').toLowerCase();
  const host = property(connector, 'host');
  return scheme && scheme !== 'file' ? `${scheme}://${host}` : host;
}

/** The connector types Mirth can test, by the Java class of their properties. */
const CONNECTION_TESTS: Record<
  string,
  (connector: ConnectorXml) => Omit<ConnectionTestPlan, 'body' | 'contentType'>
> = {
  'com.mirth.connect.connectors.tcp.TcpDispatcherProperties': (connector) => ({
    path: '/connectors/tcp/_testConnection',
    attempt: `open a TCP connection to ${property(connector, 'remoteAddress')}:${property(connector, 'remotePort')}`,
  }),
  'com.mirth.connect.connectors.http.HttpDispatcherProperties': (connector) => ({
    path: '/connectors/http/_testConnection',
    attempt: `reach ${property(connector, 'host')}`,
  }),
  'com.mirth.connect.connectors.ws.WebServiceDispatcherProperties': (connector) => ({
    path: '/connectors/ws/_testConnection',
    attempt: `reach ${property(connector, 'locationURI') || property(connector, 'wsdlUrl')}`,
  }),
  'com.mirth.connect.connectors.file.FileDispatcherProperties': (connector) => ({
    path: '/connectors/file/_testWrite',
    attempt: `write to ${fileTarget(connector)}`,
  }),
  'com.mirth.connect.connectors.file.FileReceiverProperties': (connector) => ({
    path: '/connectors/file/_testRead',
    attempt: `read from ${fileTarget(connector)}`,
  }),
  'com.mirth.connect.connectors.doc.DocumentDispatcherProperties': (connector) => ({
    path: '/connectors/doc/_testWrite',
    attempt: `write to ${property(connector, 'host')}`,
  }),
};

/** The transport names Mirth can test, for the refusal that names what it cannot. */
export const TESTABLE_TRANSPORTS =
  'TCP Sender, HTTP Sender, Web Service Sender, File Reader, File Writer and Document Writer';

/**
 * How to test this connector, or null when Mirth has no test for its type
 * (a listener, a database, a channel or JavaScript writer, JMS, DICOM,
 * SMTP…). The Document Writer's test takes only the directory, as text;
 * every other test takes the whole properties document.
 */
export function connectionTestOf(connector: ConnectorXml): ConnectionTestPlan | null {
  const plan = CONNECTION_TESTS[connector.propertiesClass];
  if (!plan) return null;
  const route = plan(connector);
  if (connector.propertiesClass.endsWith('.DocumentDispatcherProperties')) {
    return { ...route, body: property(connector, 'host'), contentType: 'text/plain' };
  }
  return { ...route, body: propertiesDocument(connector), contentType: 'application/xml' };
}

/** `source "sourceConnector" (TCP Listener)` / `destination 2 "To Lab" (TCP Sender)`. */
export function connectorLabel(connector: ConnectorXml): string {
  const where = connector.role === 'source' ? 'source' : `destination ${connector.metaDataId}`;
  return `${where} "${connector.name}" (${connector.transportName || connector.propertiesClass.split('.').pop() || 'unknown type'})${connector.enabled ? '' : ', disabled'}`;
}

/**
 * Mirth's ConnectionTestResponse — `{"type": "SUCCESS", "message": "…",
 * "connectionInfo": "…"}`, usually under its class name as the one key —
 * as a plain result. Anything else reads as UNKNOWN with the text kept.
 */
export function connectionTestResultOf(value: unknown): ConnectionTestResult {
  const root =
    isRecord(value) && typeof value.type === 'string'
      ? value
      : isRecord(value)
        ? Object.values(value).find(
            (inner): inner is Record<string, unknown> =>
              isRecord(inner) && typeof inner.type === 'string'
          )
        : undefined;
  const type = root ? String(root.type) : '';
  return {
    type: type === 'SUCCESS' || type === 'TIME_OUT' || type === 'FAILURE' ? type : 'UNKNOWN',
    message: root && typeof root.message === 'string' ? root.message : '',
    connectionInfo: root && typeof root.connectionInfo === 'string' ? root.connectionInfo : '',
  };
}

/** One readable line for a test's outcome. */
export function connectionTestLine(
  connector: ConnectorXml,
  plan: ConnectionTestPlan,
  result: ConnectionTestResult
): string {
  const verdict =
    result.type === 'SUCCESS'
      ? 'SUCCESS'
      : result.type === 'TIME_OUT'
        ? 'TIMED OUT'
        : result.type === 'FAILURE'
          ? 'FAILED'
          : 'UNKNOWN (Mirth answered in an unexpected shape)';
  const detail = [result.message, result.connectionInfo].filter(Boolean).join(' — ');
  return `${connectorLabel(connector)}: ${verdict} trying to ${plan.attempt}${detail ? ` — ${detail}` : ''}`;
}
