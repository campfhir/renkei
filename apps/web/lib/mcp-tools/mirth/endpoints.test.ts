/**
 * Finding channels by their wiring: the address each connector type
 * shows, and what a host, port or fragment matches — including a
 * listener on every interface and localhost's other spellings.
 */

import { connectorEndpointsOf, endpointLine, matchesEndpoint, splitHostPort } from './endpoints';

const channels = {
  list: {
    channel: [
      {
        id: 'c1',
        name: 'ADT In',
        sourceConnector: {
          name: 'sourceConnector',
          transportName: 'TCP Listener',
          metaDataId: 0,
          properties: { listenerConnectorProperties: { host: '0.0.0.0', port: '6661' } },
        },
        destinationConnectors: {
          connector: [
            {
              name: 'To Epic',
              transportName: 'TCP Sender',
              metaDataId: 1,
              properties: { remoteAddress: 'localhost', remotePort: '8888' },
            },
            {
              name: 'Post',
              transportName: 'HTTP Sender',
              metaDataId: 2,
              enabled: false,
              properties: { host: 'https://api.example.org:8443/hl7', method: 'POST' },
            },
            {
              name: 'Drop',
              transportName: 'File Writer',
              metaDataId: 3,
              properties: {
                scheme: 'SFTP',
                host: 'sftp.example.org:22/outbound',
                outputPattern: '${date}.hl7',
              },
            },
          ],
        },
      },
      {
        id: 'c2',
        name: 'Nightly',
        sourceConnector: {
          name: 'sourceConnector',
          transportName: 'Database Reader',
          properties: { url: 'jdbc:postgresql://db.example.org:5432/ehr', username: 'mirth' },
        },
        destinationConnectors: {
          connector: {
            name: 'Script',
            transportName: 'JavaScript Writer',
            metaDataId: 1,
            properties: { script: 'return;' },
          },
        },
      },
    ],
  },
};

const all = connectorEndpointsOf(channels);
const byName = (connectorName: string) => all.find((e) => e.connectorName === connectorName)!;

describe('connectorEndpointsOf', () => {
  it('phrases each connector type by its own address fields', () => {
    expect(all.map(endpointLine)).toEqual([
      '  source: TCP Listener → 0.0.0.0:6661',
      '  destination 1 "To Epic": TCP Sender → localhost:8888',
      '  destination 2 "Post": HTTP Sender → https://api.example.org:8443/hl7 (disabled)',
      '  destination 3 "Drop": File Writer → sftp://sftp.example.org:22/outbound ${date}.hl7',
      '  source: Database Reader → jdbc:postgresql://db.example.org:5432/ehr',
      '  destination 1 "Script": JavaScript Writer',
    ]);
    expect(all[0]).toMatchObject({ channelId: 'c1', channelName: 'ADT In', role: 'source' });
  });
});

describe('splitHostPort', () => {
  it('splits "host:port" and leaves a bare host or an explicit port alone', () => {
    expect(splitHostPort('localhost:8888', undefined)).toEqual({ host: 'localhost', port: 8888 });
    expect(splitHostPort('localhost', 80)).toEqual({ host: 'localhost', port: 80 });
    expect(splitHostPort(undefined, undefined)).toEqual({ host: '', port: undefined });
  });
});

describe('matchesEndpoint', () => {
  it('finds the sender to localhost:8888 and not the others', () => {
    const hits = all.filter((e) => matchesEndpoint(e, { host: 'localhost:8888' }));
    expect(hits.map((e) => e.connectorName)).toEqual(['To Epic']);
  });

  it('treats 127.0.0.1 and localhost as one, and a port alone as a port', () => {
    expect(matchesEndpoint(byName('To Epic'), { host: '127.0.0.1' })).toBe(true);
    expect(
      all.filter((e) => matchesEndpoint(e, { port: 8443 })).map((e) => e.connectorName)
    ).toEqual(['Post']);
    expect(matchesEndpoint(byName('Post'), { port: 844 })).toBe(false);
  });

  it('lets a listener on every interface answer any host, on its port', () => {
    expect(matchesEndpoint(byName('sourceConnector'), { host: 'mirth.example.org:6661' })).toBe(
      true
    );
    expect(matchesEndpoint(byName('sourceConnector'), { host: 'mirth.example.org:6662' })).toBe(
      false
    );
  });

  it('matches a fragment anywhere in the properties, a transport, and a role', () => {
    expect(
      all.filter((e) => matchesEndpoint(e, { text: 'outbound' })).map((e) => e.connectorName)
    ).toEqual(['Drop']);
    expect(
      all
        .filter((e) => matchesEndpoint(e, { text: 'example.org', transport: 'sender' }))
        .map((e) => e.connectorName)
    ).toEqual(['Post']);
    expect(
      all
        .filter((e) => matchesEndpoint(e, { host: 'db.example.org', role: 'source' }))
        .map((e) => e.channelName)
    ).toEqual(['Nightly']);
  });
});
