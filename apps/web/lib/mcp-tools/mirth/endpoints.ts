/**
 * Where a channel's connectors listen and send, read from channel
 * definitions so a person can ask by what they know — "the channel
 * sending to localhost:8888", "what listens on 6661", "who writes to
 * /data/outbound" — instead of by name. Pure: index.ts fetches, this
 * file reads and matches.
 *
 * Each connector type keeps its address under its own property names
 * (a TCP listener under listenerConnectorProperties.host/port, a TCP
 * sender under remoteAddress/remotePort, an HTTP sender in `host` as a
 * URL, a file connector in scheme + host + pattern, a database in
 * `url`…). The display label follows those; the MATCH looks at every
 * scalar the connector's properties hold, so a type this file does not
 * phrase is still found by what it contains.
 */

import { isRecord } from '@renkei/guards';
import { textOf, unwrapList } from '@renkei/connector-mirth';

export interface ConnectorEndpoint {
  channelId: string;
  channelName: string;
  role: 'source' | 'destination';
  metaDataId: number;
  connectorName: string;
  transport: string;
  enabled: boolean;
  /** The address a person would recognise, or '' when the type has none (JavaScript). */
  endpoint: string;
  /** Every scalar the connector's properties hold, for matching. */
  values: string[];
}

export interface EndpointQuery {
  /** A host, optionally with ":port" ("localhost:8888"). */
  host?: string;
  port?: number;
  /** A fragment to find anywhere in the connector's properties (a path, a URL, a user). */
  text?: string;
  /** A transport name fragment ("TCP", "File Writer"). */
  transport?: string;
  role?: 'source' | 'destination';
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** Every scalar under a record, deeply, as text. */
function scalars(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 8) return into;
  if (typeof value === 'string' || typeof value === 'number') {
    if (str(value).trim()) into.push(str(value));
  } else if (Array.isArray(value)) {
    for (const item of value) scalars(item, into, depth + 1);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('@')) continue;
      scalars(item, into, depth + 1);
    }
  }
  return into;
}

/** The address a connector type shows, from its properties. */
function endpointOf(transport: string, properties: Record<string, unknown>): string {
  const listener = isRecord(properties.listenerConnectorProperties)
    ? properties.listenerConnectorProperties
    : null;
  if (listener) {
    const base = `${str(listener.host) || '0.0.0.0'}:${str(listener.port)}`;
    const context = str(properties.contextPath);
    const service = str(properties.serviceName);
    return `${base}${context ? context : ''}${service ? ` service ${service}` : ''}`;
  }
  if (str(properties.remoteAddress)) {
    return `${str(properties.remoteAddress)}:${str(properties.remotePort)}`;
  }
  if (/^http sender$/i.test(transport) || /^(https?):\/\//i.test(str(properties.host))) {
    return str(properties.host);
  }
  if (str(properties.scheme)) {
    const scheme = str(properties.scheme).toLowerCase();
    const where = str(properties.host);
    const pattern = str(properties.outputPattern) || str(properties.fileFilter);
    return `${scheme === 'file' ? '' : `${scheme}://`}${where}${pattern ? ` ${pattern}` : ''}`;
  }
  if (str(properties.url)) return str(properties.url);
  if (str(properties.smtpHost)) {
    return `smtp ${str(properties.smtpHost)}:${str(properties.smtpPort)}${str(properties.to) ? ` to ${str(properties.to)}` : ''}`;
  }
  if (str(properties.wsdlUrl) || str(properties.locationURI)) {
    return str(properties.locationURI) || str(properties.wsdlUrl);
  }
  if (str(properties.channelId)) return `channel ${str(properties.channelId)}`;
  if (str(properties.host) && str(properties.port)) {
    return `${str(properties.host)}:${str(properties.port)}`;
  }
  if (str(properties.host)) return str(properties.host);
  if (str(properties.destinationName)) return `queue ${str(properties.destinationName)}`;
  return '';
}

function connectorOf(
  channel: { id: string; name: string },
  role: 'source' | 'destination',
  connector: unknown
): ConnectorEndpoint | null {
  if (!isRecord(connector)) return null;
  const properties = isRecord(connector.properties) ? connector.properties : {};
  const transport = str(connector.transportName);
  return {
    channelId: channel.id,
    channelName: channel.name,
    role,
    metaDataId: Number(connector.metaDataId ?? (role === 'source' ? 0 : NaN)) || 0,
    connectorName: str(connector.name),
    transport,
    enabled: !(connector.enabled === false || connector.enabled === 'false'),
    endpoint: endpointOf(transport, properties),
    values: scalars(properties),
  };
}

/** The connectors of every channel in a GET /channels answer, with their endpoints. */
export function connectorEndpointsOf(body: unknown): ConnectorEndpoint[] {
  return unwrapList(body).flatMap((channel) => {
    if (!isRecord(channel) || !str(channel.id)) return [];
    const header = { id: str(channel.id), name: textOf(channel.name) };
    const source = connectorOf(header, 'source', channel.sourceConnector);
    const destinations = isRecord(channel.destinationConnectors)
      ? unwrapList(channel.destinationConnectors)
      : [];
    return [
      ...(source ? [source] : []),
      ...destinations.flatMap((destination) => {
        const one = connectorOf(header, 'destination', destination);
        return one ? [one] : [];
      }),
    ];
  });
}

/** "localhost:8888" → host + port; a bare host or a bare port stays as given. */
export function splitHostPort(host: string | undefined, port: number | undefined) {
  const trimmed = (host ?? '').trim();
  const match = /^(.*):(\d{1,5})$/.exec(trimmed);
  if (match && port === undefined) return { host: match[1], port: Number(match[2]) };
  return { host: trimmed, port };
}

const LISTEN_ALL = new Set(['0.0.0.0', '::', '']);
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether a connector answers a query: every given part must hold. A host
 * matches a value containing it (so a URL counts); a listener on all
 * interfaces matches any host; localhost and 127.0.0.1 match each other.
 * A port matches a value that is exactly it, or a host:port / URL that
 * carries it.
 */
export function matchesEndpoint(endpoint: ConnectorEndpoint, query: EndpointQuery): boolean {
  const { host, port } = splitHostPort(query.host, query.port);
  const lower = endpoint.values.map((value) => value.toLowerCase());
  if (query.role && endpoint.role !== query.role) return false;
  if (
    query.transport &&
    !endpoint.transport.toLowerCase().includes(query.transport.toLowerCase())
  ) {
    return false;
  }
  if (query.text && !lower.some((value) => value.includes(query.text!.toLowerCase()))) {
    return false;
  }
  if (host) {
    const wanted = LOCAL.has(host.toLowerCase()) ? [...LOCAL] : [host.toLowerCase()];
    // A listener on every interface answers to any host — but only when
    // the question names a port, or every listener would match every host.
    const listensEverywhere =
      port !== undefined &&
      endpoint.role === 'source' &&
      /^[^:]*:\d+/.test(endpoint.endpoint) &&
      LISTEN_ALL.has(endpoint.endpoint.split(':')[0]);
    if (!listensEverywhere && !lower.some((value) => wanted.some((h) => value.includes(h)))) {
      return false;
    }
  }
  if (port !== undefined) {
    const digits = String(port);
    const hit = lower.some(
      (value) => value === digits || new RegExp(`[:\\s]${digits}(?![0-9])`).test(value)
    );
    if (!hit) return false;
  }
  return true;
}

/** One line per connector: role, transport, endpoint, connector name. */
export function endpointLine(endpoint: ConnectorEndpoint): string {
  const role =
    endpoint.role === 'source'
      ? 'source'
      : `destination ${endpoint.metaDataId} "${endpoint.connectorName}"`;
  return `  ${role}: ${endpoint.transport}${endpoint.endpoint ? ` → ${endpoint.endpoint}` : ''}${endpoint.enabled ? '' : ' (disabled)'}`;
}
