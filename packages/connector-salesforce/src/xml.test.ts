import { readMetadataRecords } from './xml';

const REFERRALS_ANSWER = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Body>
    <readMetadataResponse>
      <result>
        <records xsi:type="ReportType">
          <fullName>Referrals</fullName>
          <baseObject>Referral</baseObject>
          <category>other</category>
          <deployed>true</deployed>
          <description>Referrals &amp; their clients</description>
          <label>Referrals</label>
          <sections>
            <columns>
              <checkedByDefault>true</checkedByDefault>
              <field>Name</field>
              <table>Referral</table>
            </columns>
            <columns>
              <checkedByDefault>false</checkedByDefault>
              <displayNameOverride>Stage</displayNameOverride>
              <field>Referral_Stage__c</field>
              <table>Referral</table>
            </columns>
            <masterLabel>Referrals</masterLabel>
          </sections>
          <sections>
            <columns>
              <checkedByDefault>false</checkedByDefault>
              <field>Client.Medicare_Status__c</field>
              <table>Referral</table>
            </columns>
            <masterLabel>Account</masterLabel>
          </sections>
        </records>
      </result>
    </readMetadataResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

describe('readMetadataRecords', () => {
  it('reads a record into the Tooling API’s JSON shape, in the answer’s order', () => {
    const records = readMetadataRecords(REFERRALS_ANSWER);
    expect(Array.isArray(records)).toBe(true);
    if (!Array.isArray(records)) return;
    const [record] = records;
    expect(record).toMatchObject({
      fullName: 'Referrals',
      baseObject: 'Referral',
      description: 'Referrals & their clients',
      deployed: 'true',
    });
    expect(Object.keys(record ?? {})).toEqual([
      'fullName',
      'baseObject',
      'category',
      'deployed',
      'description',
      'label',
      'sections',
    ]);
    const sections = record?.sections;
    expect(Array.isArray(sections) && sections.length).toBe(2);
    // One column in a section reads as an object, not an array of one.
    expect(Array.isArray(sections) && sections[1]).toEqual({
      columns: { checkedByDefault: 'false', field: 'Client.Medicare_Status__c', table: 'Referral' },
      masterLabel: 'Account',
    });
  });

  it('reads a name that names nothing as null, and a fault as its message', () => {
    expect(
      readMetadataRecords(
        '<soapenv:Envelope xmlns:soapenv="x" xmlns:xsi="y"><soapenv:Body><readMetadataResponse><result><records xsi:nil="true"/></result></readMetadataResponse></soapenv:Body></soapenv:Envelope>'
      )
    ).toEqual([null]);
    expect(
      readMetadataRecords(
        '<soapenv:Envelope xmlns:soapenv="x"><soapenv:Body><soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode><faultstring>INVALID_TYPE: bad</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>'
      )
    ).toEqual({ fault: 'INVALID_TYPE: bad' });
    expect(readMetadataRecords('not xml')).toEqual({
      fault: 'The answer was not a SOAP envelope.',
    });
  });
});
