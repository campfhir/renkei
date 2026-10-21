import {
  checkRecordTypeSpec,
  objectChildXml,
  profileOverlayFile,
  recordTypeMetadata,
  recordTypePicklists,
} from './record-types';

const known = { Stage__c: ['Draft', 'Done', 'Closed/Lost'], StageName: ['Prospecting'] };

describe('checkRecordTypeSpec', () => {
  it('derives the name, spells values the picklist’s way, and keeps the default', () => {
    const checked = checkRecordTypeSpec(
      {
        object: 'Site_Visit__c',
        label: 'Home Visit',
        picklists: [{ picklist: 'stage__c', values: ['draft', 'closed/lost'], default: 'Draft' }],
      },
      [],
      known
    );
    expect(checked).toEqual({
      ok: true,
      value: {
        object: 'Site_Visit__c',
        name: 'Home_Visit',
        label: 'Home Visit',
        active: true,
        picklists: [{ picklist: 'Stage__c', values: ['Draft', 'Closed/Lost'], default: 'Draft' }],
      },
    });
    if (!checked.ok) return;
    const xml = objectChildXml('recordTypes', 'Home_Visit', recordTypeMetadata(checked.value));
    expect(xml).toContain('<fullName>Home_Visit</fullName>');
    expect(xml).toContain('<fullName>Closed%2FLost</fullName>');
    expect(xml).toContain('<picklist>Stage__c</picklist>');
    expect(xml).not.toContain('businessProcess');
  });

  it('needs a business process on Opportunity, and refuses clashes and unknown values', () => {
    const errors = (input: Parameters<typeof checkRecordTypeSpec>[0]) => {
      const checked = checkRecordTypeSpec(input, [{ name: 'Grant', label: 'Grants' }], known);
      return checked.ok ? [] : checked.errors;
    };
    expect(errors({ object: 'Opportunity', label: 'Donation' })).toEqual([
      'A Opportunity record type needs its sales process: name one (businessProcess).',
    ]);
    expect(errors({ object: 'Opportunity', label: 'Grant', businessProcess: 'Grants' })).toEqual([
      'Opportunity already has a record type Grant.',
    ]);
    expect(
      errors({
        object: 'Site_Visit__c',
        label: 'Phone',
        picklists: [{ picklist: 'Stage__c', values: ['Nope'] }],
      })
    ).toEqual([
      'Stage__c: "Nope" is not one of its values.',
      'Stage__c: a record type offers at least one value.',
    ]);
  });
});

describe('reading and profiles', () => {
  it('reads what a record type offers, decoded', () => {
    expect(
      recordTypePicklists({
        picklistValues: [
          {
            picklist: 'Stage__c',
            values: [
              { fullName: 'Closed%2FLost', default: true },
              { fullName: 'Draft', default: false },
            ],
          },
        ],
      })
    ).toEqual([{ picklist: 'Stage__c', values: ['Closed/Lost (default)', 'Draft'] }]);
  });

  it('writes only record type access into the profile overlay', () => {
    const xml = profileOverlayFile([
      {
        recordType: 'Site_Visit__c.Home_Visit',
        default: false,
        layout: 'Site_Visit__c-Home Visit Layout',
      },
    ]);
    expect(xml).toContain('<Profile xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(xml).toContain('<recordType>Site_Visit__c.Home_Visit</recordType>');
    expect(xml).toContain('<visible>true</visible>');
    expect(xml).toContain('<layout>Site_Visit__c-Home Visit Layout</layout>');
    expect(xml).not.toContain('userPermissions');
  });
});
