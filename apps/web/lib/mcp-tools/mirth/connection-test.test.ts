/**
 * Testing a connector's connection: which connector of a channel's XML
 * is meant, which Mirth connector service tests it with what body, and
 * how Mirth's verdict reads back.
 */

import {
  channelConnectorsOf,
  connectionTestLine,
  connectionTestOf,
  connectionTestResultOf,
  connectorLabel,
} from './connection-test';

/** A channel as GET /channels/{id} answers in XML, cut down to what matters. */
const CHANNEL_XML = `<channel version="4.5.2">
  <id>c1</id>
  <nextMetaDataId>5</nextMetaDataId>
  <name>ADT &amp; Orders</name>
  <description>Inbound ADT</description>
  <revision>7</revision>
  <sourceConnector version="4.5.2">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.tcp.TcpReceiverProperties" version="4.5.2">
      <pluginProperties/>
      <listenerConnectorProperties version="4.5.2">
        <host>0.0.0.0</host>
        <port>6661</port>
      </listenerConnectorProperties>
      <sourceConnectorProperties version="4.5.2">
        <responseVariable>d1</responseVariable>
      </sourceConnectorProperties>
    </properties>
    <transformer version="4.5.2">
      <elements>
        <com.mirth.connect.plugins.mapper.MapperStep version="4.5.2">
          <name>Patient name</name>
          <enabled>true</enabled>
        </com.mirth.connect.plugins.mapper.MapperStep>
      </elements>
    </transformer>
    <transportName>TCP Listener</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
  </sourceConnector>
  <destinationConnectors>
    <connector version="4.5.2">
      <metaDataId>1</metaDataId>
      <name>To Lab</name>
      <properties class="com.mirth.connect.connectors.tcp.TcpDispatcherProperties" version="4.5.2">
        <pluginProperties/>
        <destinationConnectorProperties version="4.5.2">
          <queueEnabled>false</queueEnabled>
        </destinationConnectorProperties>
        <transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">
          <pluginPointName>MLLP</pluginPointName>
        </transmissionModeProperties>
        <serverMode>false</serverMode>
        <remoteAddress>lab.example.org</remoteAddress>
        <remotePort>8888</remotePort>
        <sendTimeout>5000</sendTimeout>
        <template>\${message.encodedData}</template>
      </properties>
      <transformer version="4.5.2"><elements/></transformer>
      <responseTransformer version="4.5.2"><elements/></responseTransformer>
      <filter version="4.5.2"><elements/></filter>
      <transportName>TCP Sender</transportName>
      <mode>DESTINATION</mode>
      <enabled>true</enabled>
    </connector>
    <connector version="4.5.2">
      <metaDataId>2</metaDataId>
      <name>Archive</name>
      <properties class="com.mirth.connect.connectors.file.FileDispatcherProperties" version="4.5.2">
        <pluginProperties/>
        <scheme>SFTP</scheme>
        <schemeProperties class="com.mirth.connect.connectors.file.SftpSchemeProperties">
          <passwordAuth>true</passwordAuth>
        </schemeProperties>
        <host>sftp.example.org/outbound</host>
        <outputPattern>\${date}.hl7</outputPattern>
        <username>mirth</username>
        <password>s3cret</password>
      </properties>
      <transportName>File Writer</transportName>
      <mode>DESTINATION</mode>
      <enabled>false</enabled>
    </connector>
    <connector version="4.5.2">
      <metaDataId>3</metaDataId>
      <name>Audit</name>
      <properties class="com.mirth.connect.connectors.vm.VmDispatcherProperties" version="4.5.2">
        <pluginProperties/>
        <channelId>c9</channelId>
      </properties>
      <transportName>Channel Writer</transportName>
      <mode>DESTINATION</mode>
      <enabled>true</enabled>
    </connector>
    <connector version="4.5.2">
      <metaDataId>4</metaDataId>
      <name>Report</name>
      <properties class="com.mirth.connect.connectors.doc.DocumentDispatcherProperties" version="4.5.2">
        <pluginProperties/>
        <host>/var/reports</host>
        <outputPattern>\${date}.pdf</outputPattern>
      </properties>
      <transportName>Document Writer</transportName>
      <mode>DESTINATION</mode>
      <enabled>true</enabled>
    </connector>
  </destinationConnectors>
  <preprocessingScript>return message;</preprocessingScript>
</channel>`;

describe('channelConnectorsOf', () => {
  it('reads the channel and each connector with its own fields and its properties intact', () => {
    const channel = channelConnectorsOf(CHANNEL_XML)!;
    expect(channel.id).toBe('c1');
    expect(channel.name).toBe('ADT & Orders');
    expect(
      channel.connectors.map((connector) => [
        connector.metaDataId,
        connector.role,
        connector.name,
        connector.transportName,
        connector.enabled,
        connector.propertiesClass,
      ])
    ).toEqual([
      [
        0,
        'source',
        'sourceConnector',
        'TCP Listener',
        true,
        'com.mirth.connect.connectors.tcp.TcpReceiverProperties',
      ],
      [
        1,
        'destination',
        'To Lab',
        'TCP Sender',
        true,
        'com.mirth.connect.connectors.tcp.TcpDispatcherProperties',
      ],
      [
        2,
        'destination',
        'Archive',
        'File Writer',
        false,
        'com.mirth.connect.connectors.file.FileDispatcherProperties',
      ],
      [
        3,
        'destination',
        'Audit',
        'Channel Writer',
        true,
        'com.mirth.connect.connectors.vm.VmDispatcherProperties',
      ],
      [
        4,
        'destination',
        'Report',
        'Document Writer',
        true,
        'com.mirth.connect.connectors.doc.DocumentDispatcherProperties',
      ],
    ]);
    const toLab = channel.connectors[1];
    expect(toLab.propertiesAttributes).toBe('version="4.5.2"');
    expect(toLab.propertiesXml).toContain('<remoteAddress>lab.example.org</remoteAddress>');
    expect(toLab.propertiesXml).toContain('<pluginPointName>MLLP</pluginPointName>');
    expect(toLab.propertiesXml).not.toContain('<transformer');
  });

  it('is not fooled by names and enabled flags inside the properties', () => {
    // The source's transformer step is named and enabled too; the
    // connector's own name comes from outside its properties element.
    const source = channelConnectorsOf(CHANNEL_XML)!.connectors[0];
    expect(source.name).toBe('sourceConnector');
    expect(source.enabled).toBe(true);
  });

  it('answers null for a document that is not a channel', () => {
    expect(channelConnectorsOf('')).toBeNull();
    expect(channelConnectorsOf('<list/>')).toBeNull();
    expect(channelConnectorsOf('<channel version="4.5.2"><name>x</name></channel>')).toBeNull();
  });
});

describe('connectionTestOf', () => {
  const connectors = channelConnectorsOf(CHANNEL_XML)!.connectors;

  it("posts a sender's whole properties element, re-rooted under its class, to its test route", () => {
    const plan = connectionTestOf(connectors[1])!;
    expect(plan.path).toBe('/connectors/tcp/_testConnection');
    expect(plan.contentType).toBe('application/xml');
    expect(plan.attempt).toBe('open a TCP connection to lab.example.org:8888');
    expect(plan.body).toMatch(
      /^<com\.mirth\.connect\.connectors\.tcp\.TcpDispatcherProperties version="4\.5\.2">[\s\S]*<\/com\.mirth\.connect\.connectors\.tcp\.TcpDispatcherProperties>$/
    );
    expect(plan.body).toContain('<remoteAddress>lab.example.org</remoteAddress>');
    expect(plan.body).toContain(
      '<transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">'
    );
  });

  it('tests a file writer with _testWrite and names the scheme and host', () => {
    const plan = connectionTestOf(connectors[2])!;
    expect(plan.path).toBe('/connectors/file/_testWrite');
    expect(plan.attempt).toBe('write to sftp://sftp.example.org/outbound');
    expect(plan.body).toContain('<username>mirth</username>');
  });

  it('tests a document writer with its directory as plain text', () => {
    const plan = connectionTestOf(connectors[4])!;
    expect(plan).toEqual({
      path: '/connectors/doc/_testWrite',
      attempt: 'write to /var/reports',
      body: '/var/reports',
      contentType: 'text/plain',
    });
  });

  it('tests a file reader with _testRead', () => {
    const reader = channelConnectorsOf(
      '<channel><id>c2</id><name>Drop</name><sourceConnector><metaDataId>0</metaDataId><name>sourceConnector</name>' +
        '<properties class="com.mirth.connect.connectors.file.FileReceiverProperties" version="4.5.2"><scheme>FILE</scheme><host>/data/in</host><fileFilter>*.hl7</fileFilter></properties>' +
        '<transportName>File Reader</transportName></sourceConnector></channel>'
    )!.connectors[0];
    const plan = connectionTestOf(reader)!;
    expect(plan.path).toBe('/connectors/file/_testRead');
    expect(plan.attempt).toBe('read from /data/in');
    expect(plan.body).toBe(
      '<com.mirth.connect.connectors.file.FileReceiverProperties version="4.5.2"><scheme>FILE</scheme><host>/data/in</host><fileFilter>*.hl7</fileFilter></com.mirth.connect.connectors.file.FileReceiverProperties>'
    );
  });

  it('has no test for a listener or a channel writer', () => {
    expect(connectionTestOf(connectors[0])).toBeNull();
    expect(connectionTestOf(connectors[3])).toBeNull();
  });
});

describe("Mirth's verdict", () => {
  it('reads the response under its class name or bare', () => {
    expect(
      connectionTestResultOf({
        'com.mirth.connect.util.ConnectionTestResponse': {
          type: 'SUCCESS',
          message: 'Successfully connected to host: lab.example.org:8888',
          connectionInfo: 'from 10.0.0.5:51234',
        },
      })
    ).toEqual({
      type: 'SUCCESS',
      message: 'Successfully connected to host: lab.example.org:8888',
      connectionInfo: 'from 10.0.0.5:51234',
    });
    expect(connectionTestResultOf({ type: 'TIME_OUT', message: 'Timed out' })).toEqual({
      type: 'TIME_OUT',
      message: 'Timed out',
      connectionInfo: '',
    });
    expect(connectionTestResultOf('garbage')).toEqual({
      type: 'UNKNOWN',
      message: '',
      connectionInfo: '',
    });
  });

  it('phrases one line per connector, verdict first', () => {
    const connectors = channelConnectorsOf(CHANNEL_XML)!.connectors;
    const plan = connectionTestOf(connectors[2])!;
    expect(
      connectionTestLine(connectors[2], plan, {
        type: 'FAILURE',
        message: 'Auth fail',
        connectionInfo: '',
      })
    ).toBe(
      'destination 2 "Archive" (File Writer), disabled: FAILED trying to write to sftp://sftp.example.org/outbound — Auth fail'
    );
    expect(connectorLabel(connectors[0])).toBe('source "sourceConnector" (TCP Listener)');
  });
});
