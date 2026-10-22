import { metadataBody, metadataFile, metadataFileName } from './metadata-xml';

describe('metadata XML from the Tooling API’s JSON', () => {
  it('drops the top-level Tooling keys but keeps nested fullName, nulls left out', () => {
    const body = metadataBody({
      fullName: 'Site_Visit__c.Stage__c',
      urls: null,
      label: 'Stage & status',
      inlineHelpText: null,
      valueSet: {
        valueSetDefinition: {
          value: [
            { fullName: 'Draft', default: true },
            { fullName: 'Done', default: false },
          ],
        },
      },
    });
    expect(body).not.toContain('Site_Visit__c.Stage__c');
    expect(body).not.toContain('urls');
    expect(body).not.toContain('inlineHelpText');
    expect(body).toContain('<label>Stage &amp; status</label>');
    expect(body.match(/<value>/g)).toHaveLength(2);
    expect(body).toContain('<fullName>Draft</fullName>');
    expect(body).toContain('<fullName>Done</fullName>');
  });

  it('writes a whole component, and names its file the way the Metadata API does', () => {
    expect(metadataFile('CustomTab', { motif: 'Custom18: Form', empty: {} })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '    <motif>Custom18: Form</motif>\n    <empty/>\n</CustomTab>\n'
    );
    expect(metadataFileName('Account-Account (Marketing) Layout')).toBe(
      'Account-Account %28Marketing%29 Layout'
    );
  });
});
