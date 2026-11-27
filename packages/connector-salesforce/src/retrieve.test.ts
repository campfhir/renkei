import {
  checkRetrieveBody,
  readRetrieveSelection,
  readRetrieveStarted,
  readRetrieveStatus,
  retrieveBody,
} from './retrieve';

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

describe('a retrieve’s selection', () => {
  it('reads types and their members, trimmed', () => {
    expect(
      readRetrieveSelection([
        { type: 'CustomObject', members: ['Account', ' Visit__c '] },
        { type: 'Layout', members: ['Account-Account %28Sales%29 Layout'] },
        { type: 'ApexClass', members: ['*'] },
      ])
    ).toEqual({
      ok: true,
      types: [
        { type: 'CustomObject', members: ['Account', 'Visit__c'] },
        { type: 'Layout', members: ['Account-Account %28Sales%29 Layout'] },
        { type: 'ApexClass', members: ['*'] },
      ],
    });
  });

  it('says what is wrong with one, in words', () => {
    const error = (value: unknown) => {
      const read = readRetrieveSelection(value);
      return read.ok ? null : read.error;
    };
    expect(error([])).toMatch(/at least one/);
    expect(error('CustomObject')).toMatch(/at least one/);
    expect(error([{ type: 'Custom Object', members: ['A'] }])).toMatch(/not a metadata type/);
    expect(error([{ type: 'CustomObject', members: [] }])).toMatch(/or \* for all/);
    expect(error([{ type: 'CustomObject', members: ['A<b>'] }])).toMatch(/not a CustomObject/);
    expect(error([{ type: 'CustomObject', members: ['A&amp;B'] }])).toMatch(/not a CustomObject/);
    expect(
      error([{ type: 'CustomObject', members: Array.from({ length: 5_001 }, (_, i) => `A${i}`) }])
    ).toMatch(/At most 5000 members/);
  });
});

describe('the bodies the delegate takes', () => {
  it('names only types and members, or a retrieve', () => {
    expect(
      retrieveBody([
        { type: 'CustomObject', members: ['Account', 'Visit__c'] },
        { type: 'ApexClass', members: ['*'] },
      ])
    ).toBe(
      '<retrieve xmlns="http://soap.sforce.com/2006/04/metadata">' +
        '<types><name>CustomObject</name><members>Account</members><members>Visit__c</members></types>' +
        '<types><name>ApexClass</name><members>*</members></types></retrieve>'
    );
    expect(checkRetrieveBody('09S5e000001AbCdEAK')).toBe(
      '<checkRetrieveStatus xmlns="http://soap.sforce.com/2006/04/metadata"><asyncProcessId>09S5e000001AbCdEAK</asyncProcessId></checkRetrieveStatus>'
    );
  });
});

describe('Salesforce’s answers', () => {
  it('reads the id of a retrieve it started, and a fault as its message', () => {
    expect(
      readRetrieveStarted(
        envelope(
          '<retrieveResponse><result><done>false</done><id>09S5e000001AbCdEAK</id><state>Queued</state></result></retrieveResponse>'
        )
      )
    ).toEqual({ id: '09S5e000001AbCdEAK' });
    expect(
      readRetrieveStarted(
        envelope(
          '<soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode><faultstring>INVALID_TYPE: Unknown type name</faultstring></soapenv:Fault>'
        )
      )
    ).toEqual({ fault: 'INVALID_TYPE: Unknown type name' });
    expect(readRetrieveStarted('nonsense')).toMatchObject({ fault: expect.any(String) });
  });

  it('reads a retrieve still running', () => {
    expect(
      readRetrieveStatus(
        envelope(
          '<checkRetrieveStatusResponse><result><done>false</done><id>09S5e000001AbCdEAK</id><status>InProgress</status><success>false</success></result></checkRetrieveStatusResponse>'
        )
      )
    ).toEqual({ done: false });
  });

  it('reads a finished one: the zip, what is in it, and what Salesforce could not give', () => {
    expect(
      readRetrieveStatus(
        envelope(
          '<checkRetrieveStatusResponse><result><done>true</done>' +
            '<fileProperties><fileName>objects/Visit__c.object</fileName><fullName>Visit__c</fullName><type>CustomObject</type></fileProperties>' +
            '<fileProperties><fileName>package.xml</fileName><fullName>package.xml</fullName><type>Package</type></fileProperties>' +
            '<id>09S5e000001AbCdEAK</id>' +
            '<messages><fileName>package.xml</fileName><problem>Entity of type &apos;CustomObject&apos; named &apos;Gone__c&apos; cannot be found</problem></messages>' +
            '<status>Succeeded</status><success>true</success><zipFile>UEsDBA==</zipFile></result></checkRetrieveStatusResponse>'
        )
      )
    ).toEqual({
      done: true,
      zip: 'UEsDBA==',
      components: [{ type: 'CustomObject', fullName: 'Visit__c' }],
      problems: ["Entity of type 'CustomObject' named 'Gone__c' cannot be found"],
      error: null,
    });
  });

  it('reads a failed one as why, with no zip', () => {
    expect(
      readRetrieveStatus(
        envelope(
          '<checkRetrieveStatusResponse><result><done>true</done><errorMessage>LIMIT_EXCEEDED: Too many files in retrieve call, limit is: 10000</errorMessage><errorStatusCode>LIMIT_EXCEEDED</errorStatusCode><status>Failed</status><success>false</success></result></checkRetrieveStatusResponse>'
        )
      )
    ).toEqual({
      done: true,
      zip: '',
      components: [],
      problems: [],
      error: 'LIMIT_EXCEEDED: Too many files in retrieve call, limit is: 10000',
    });
  });
});
