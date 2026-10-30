import { isExpiredSession, salesforceSoapRequest } from './salesforce-soap';

const ORG = 'https://acme--uat.sandbox.my.salesforce.com';
const read = (inner: string) =>
  Buffer.from(
    `<readMetadata xmlns="http://soap.sforce.com/2006/04/metadata">${inner}</readMetadata>`
  );
const READ_REFERRALS = read('<type>ReportType</type><fullNames>Referrals</fullNames>');

describe('salesforceSoapRequest', () => {
  it('leaves every other call alone', () => {
    expect(
      salesforceSoapRequest(
        true,
        new URL(`${ORG}/services/data/v68.0/query`),
        'GET',
        Buffer.alloc(0)
      )
    ).toBeNull();
  });

  it('wraps an admin readMetadata in an envelope carrying the session, escaped', () => {
    const soap = salesforceSoapRequest(
      true,
      new URL(`${ORG}/services/Soap/m/68.0`),
      'POST',
      READ_REFERRALS
    );
    expect(soap).toMatchObject({ ok: true });
    if (!soap?.ok) return;
    const xml = soap.envelope('00D!abc<&>').toString('utf8');
    expect(xml).toContain('<met:sessionId>00D!abc&lt;&amp;&gt;</met:sessionId>');
    expect(xml).toContain(
      '<soapenv:Body><met:readMetadata><met:type>ReportType</met:type><met:fullNames>Referrals</met:fullNames></met:readMetadata></soapenv:Body>'
    );
    // Built afresh for each token, so a refreshed one replaces the old.
    expect(soap.envelope('new').toString('utf8')).toContain('<met:sessionId>new</met:sessionId>');
  });

  it('refuses SOAP on the CRM connector, other endpoints and methods, and anything but readMetadata', () => {
    const at = (path: string) => new URL(`${ORG}${path}`);
    expect(
      salesforceSoapRequest(false, at('/services/Soap/m/68.0'), 'POST', READ_REFERRALS)
    ).toEqual({
      ok: false,
      message: expect.stringContaining('admin connector'),
    });
    expect(
      salesforceSoapRequest(true, at('/services/Soap/u/68.0'), 'POST', READ_REFERRALS)
    ).toMatchObject({ ok: false });
    expect(
      salesforceSoapRequest(true, at('/services/Soap/m/68.0?x=1'), 'POST', READ_REFERRALS)
    ).toMatchObject({ ok: false });
    expect(
      salesforceSoapRequest(true, at('/services/Soap/m/68.0'), 'GET', READ_REFERRALS)
    ).toMatchObject({ ok: false });
    const refused = (body: string) =>
      salesforceSoapRequest(true, at('/services/Soap/m/68.0'), 'POST', Buffer.from(body));
    // Another operation, a whole envelope, a header of its own, markup in a name, too many names.
    expect(refused('<deploy xmlns="http://soap.sforce.com/2006/04/metadata"/>')).toMatchObject({
      ok: false,
    });
    expect(
      refused(
        '<soapenv:Envelope><soapenv:Header><SessionHeader/></soapenv:Header><soapenv:Body></soapenv:Body></soapenv:Envelope>'
      )
    ).toMatchObject({ ok: false });
    expect(
      refused(read('<type>ReportType</type><fullNames>A</fullNames><deleteMetadata/>').toString())
    ).toMatchObject({ ok: false });
    expect(
      refused(read('<type>ReportType</type><fullNames>A&amp;B</fullNames>').toString())
    ).toMatchObject({ ok: false });
    expect(
      refused(read(`<type>ReportType</type>${'<fullNames>A</fullNames>'.repeat(11)}`).toString())
    ).toMatchObject({ ok: false });
  });
});

describe('salesforceSoapRequest on crafted bodies', () => {
  const at = new URL(`${ORG}/services/Soap/m/68.0`);
  it('refuses a body past its size before reading it, and reads a crafted one in linear time', () => {
    expect(salesforceSoapRequest(true, at, 'POST', Buffer.alloc(8_193, ' '))).toMatchObject({
      ok: false,
    });
    const open =
      '<readMetadata xmlns="http://soap.sforce.com/2006/04/metadata"><type>ReportType</type>';
    const crafted = [
      `${open}${' '.repeat(8_000)}`,
      `${open}${'<fullNames>a</fullNames> '.repeat(300)}</readMetadata>`,
      `${open}<fullNames>${' '.repeat(7_900)}`,
    ];
    const started = Date.now();
    for (const body of crafted) {
      expect(salesforceSoapRequest(true, at, 'POST', Buffer.from(body))).toMatchObject({
        ok: false,
      });
    }
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('still takes whitespace between the pieces, and names with spaces', () => {
    const soap = salesforceSoapRequest(
      true,
      at,
      'POST',
      read('\n  <type>Layout</type>\n  <fullNames>Account-Account Layout</fullNames>\n')
    );
    expect(soap?.ok && soap.envelope('t').toString()).toContain(
      '<met:fullNames>Account-Account Layout</met:fullNames>'
    );
  });
});

describe('isExpiredSession', () => {
  it('reads Salesforce’s INVALID_SESSION_ID fault, and nothing else', () => {
    expect(isExpiredSession(500, '<faultcode>sf:INVALID_SESSION_ID</faultcode>')).toBe(true);
    expect(isExpiredSession(500, '<faultcode>sf:INVALID_TYPE</faultcode>')).toBe(false);
    expect(isExpiredSession(200, 'INVALID_SESSION_ID')).toBe(false);
  });
});
