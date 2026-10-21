import {
  checkWrite,
  findByNameOrLabel,
  isSystemObject,
  sortObjectsForListing,
  summarizeDescribe,
  validForIndexes,
  type DescribeSObject,
} from './describe';
import { findRelationshipPaths } from './relationships';

/** A custom object of the shape a built-out org has — nothing here is any real org's. */
const siteVisit: DescribeSObject = {
  name: 'Site_Visit__c',
  label: 'Site Visit',
  labelPlural: 'Site Visits',
  custom: true,
  createable: true,
  updateable: true,
  deletable: true,
  fields: [
    {
      name: 'Id',
      label: 'Record ID',
      type: 'id',
      createable: false,
      updateable: false,
      nillable: false,
    },
    {
      name: 'Name',
      label: 'Visit Number',
      type: 'string',
      autoNumber: true,
      nameField: true,
      createable: false,
      updateable: false,
    },
    {
      name: 'Account__c',
      label: 'Account',
      type: 'reference',
      referenceTo: ['Account'],
      relationshipName: 'Account__r',
      nillable: false,
      createable: true,
      updateable: false,
      custom: true,
    },
    {
      name: 'Stage__c',
      label: 'Stage',
      type: 'picklist',
      restrictedPicklist: true,
      createable: true,
      updateable: true,
      nillable: true,
      custom: true,
      picklistValues: [
        { value: 'Scheduled', label: 'Scheduled', active: true },
        { value: 'Completed', label: 'Completed', active: true },
        { value: 'Retired', label: 'Retired', active: false },
      ],
    },
    {
      name: 'Outcome_Reason__c',
      label: 'Outcome Reason',
      type: 'picklist',
      dependentPicklist: true,
      controllerName: 'Stage__c',
      createable: true,
      updateable: true,
      nillable: true,
      custom: true,
      picklistValues: [
        // Valid for controller index 1 (Completed): bit 1 of the first byte → 0x40 → "QA==".
        { value: 'Met goals', label: 'Met goals', active: true, validFor: 'QA==' },
        // Valid for index 0 (Scheduled): 0x80 → "gA==".
        { value: 'Awaiting', label: 'Awaiting', active: true, validFor: 'gA==' },
      ],
    },
    {
      name: 'Visit_Date__c',
      label: 'Visit Date',
      type: 'date',
      createable: true,
      updateable: true,
      nillable: true,
      custom: true,
    },
    {
      name: 'Attendees__c',
      label: 'Attendees',
      type: 'double',
      createable: true,
      updateable: true,
      nillable: true,
      custom: true,
    },
    {
      name: 'Notes__c',
      label: 'Notes',
      type: 'textarea',
      length: 10,
      createable: true,
      updateable: true,
      nillable: true,
      custom: true,
    },
    {
      name: 'Days_Open__c',
      label: 'Days Open',
      type: 'double',
      calculated: true,
      createable: false,
      updateable: false,
      custom: true,
    },
    {
      name: 'Follow_Up__c',
      label: 'Follow Up',
      type: 'boolean',
      createable: true,
      updateable: true,
      nillable: false,
      defaultedOnCreate: true,
      custom: true,
    },
  ],
  childRelationships: [
    {
      childSObject: 'Visit_Attendee__c',
      field: 'Site_Visit__c',
      relationshipName: 'Attendees__r',
      cascadeDelete: true,
    },
  ],
};

describe('checkWrite', () => {
  it('accepts labels or API names and normalizes values', () => {
    const result = checkWrite(
      siteVisit,
      {
        Account: '001000000000001',
        stage__c: 'completed',
        'Visit Date': '2026-10-21',
        Attendees: '4',
      },
      'create'
    );
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({
      Account__c: '001000000000001AAA',
      Stage__c: 'Completed',
      Visit_Date__c: '2026-10-21',
      Attendees__c: 4,
    });
  });

  it('names a missing required field on create, not on update', () => {
    expect(checkWrite(siteVisit, { Stage__c: 'Scheduled' }, 'create').errors).toEqual([
      'Creating a Site Visit needs Account__c (Account).',
    ]);
    expect(checkWrite(siteVisit, { Stage__c: 'Scheduled' }, 'update').errors).toEqual([]);
  });

  it('refuses read-only fields with the reason', () => {
    const { errors } = checkWrite(
      siteVisit,
      { Days_Open__c: 3, Name: 'SV-1', Account__c: '001000000000001' },
      'update'
    );
    expect(errors).toEqual([
      'Days_Open__c is a formula field — Salesforce computes it.',
      'Name is an auto-number field — Salesforce assigns it.',
      expect.stringContaining('Account__c is set when the record is created'),
    ]);
  });

  it('suggests a field for a typo and lists valid picklist values', () => {
    const { errors } = checkWrite(siteVisit, { Stag: 'Scheduled', Stage__c: 'Retired' }, 'update');
    expect(errors[0]).toMatch(/no field "Stag" — did you mean Stage__c/);
    expect(errors[1]).toBe(
      '"Retired" is not a value of Stage__c. Valid values: Scheduled, Completed.'
    );
  });

  it('checks types and lengths', () => {
    const { errors } = checkWrite(
      siteVisit,
      {
        Visit_Date__c: '10/21/2026',
        Attendees__c: 'many',
        Notes__c: 'far too long a note',
        Account__c: 'Acme',
      },
      'create'
    );
    expect(errors).toEqual([
      'Visit_Date__c is a date — send YYYY-MM-DD.',
      'Attendees__c is a number.',
      'Notes__c holds at most 10 characters (got 19).',
      "Account__c is a lookup to Account — send the record's id.",
    ]);
  });

  it('checks a dependent picklist against its controller, sent or current', () => {
    expect(
      checkWrite(siteVisit, { Stage__c: 'Completed', Outcome_Reason__c: 'Met goals' }, 'update')
        .errors
    ).toEqual([]);
    expect(
      checkWrite(siteVisit, { Outcome_Reason__c: 'Met goals' }, 'update', {
        current: { Stage__c: 'Scheduled' },
      }).errors
    ).toEqual([
      'Met goals is not valid for Outcome_Reason__c when Stage__c is Scheduled. Valid: Awaiting.',
    ]);
  });

  it('enforces a record type subset of picklist values', () => {
    expect(
      checkWrite(siteVisit, { Stage__c: 'Completed' }, 'update', {
        recordTypePicklists: { Stage__c: ['Scheduled'] },
      }).errors
    ).toEqual([
      '"Completed" is not a value of Stage__c for this record type. Valid values: Scheduled.',
    ]);
  });
});

describe('validForIndexes', () => {
  it('reads the bitmap most significant bit first', () => {
    expect(validForIndexes('gA==')).toEqual([0]);
    expect(validForIndexes('QA==')).toEqual([1]);
    expect(validForIndexes('wAE=')).toEqual([0, 1, 15]);
  });
});

describe('objects and names', () => {
  it('finds by API name or label and refuses a shared label', () => {
    const items = [
      { name: 'Program__c', label: 'Program' },
      { name: 'pmdm__Program__c', label: 'Program' },
      { name: 'Site_Visit__c', label: 'Site Visit', labelPlural: 'Site Visits' },
    ];
    expect(findByNameOrLabel(items, 'site visits')).toEqual({ kind: 'found', value: items[2] });
    expect(findByNameOrLabel(items, 'pmdm__program__c')).toEqual({
      kind: 'found',
      value: items[1],
    });
    expect(findByNameOrLabel(items, 'Program')).toEqual({
      kind: 'ambiguous',
      candidates: [items[0], items[1]],
    });
  });

  it("lists the org's own custom objects first and hides plumbing", () => {
    const sorted = sortObjectsForListing([
      { name: 'Account', label: 'Account', custom: false },
      { name: 'npsp__Allocation__c', label: 'GAU Allocation', custom: true },
      { name: 'Site_Visit__c', label: 'Site Visit', custom: true },
    ]);
    expect(sorted.map((o) => o.name)).toEqual(['Site_Visit__c', 'npsp__Allocation__c', 'Account']);
    expect(isSystemObject('AccountHistory')).toBe(true);
    expect(isSystemObject('Site_Visit__History')).toBe(true);
    expect(isSystemObject('Site_Visit__c')).toBe(false);
  });

  it('summarizes a describe for a model', () => {
    const summary = summarizeDescribe(siteVisit);
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Account__c', required: true, referenceTo: ['Account'] }),
        expect.objectContaining({ name: 'Stage__c', values: ['Scheduled', 'Completed'] }),
        expect.objectContaining({ name: 'Days_Open__c', readOnly: true }),
      ])
    );
    expect(summary.childRelationships).toEqual([
      {
        relationshipName: 'Attendees__r',
        childObject: 'Visit_Attendee__c',
        field: 'Site_Visit__c',
        deletedWithParent: true,
      },
    ]);
  });
});

describe('findRelationshipPaths', () => {
  const account: DescribeSObject = {
    name: 'Account',
    label: 'Account',
    labelPlural: 'Accounts',
    fields: [{ name: 'Id', label: 'Id', type: 'id' }],
    childRelationships: [
      { childSObject: 'Site_Visit__c', field: 'Account__c', relationshipName: 'Site_Visits__r' },
      { childSObject: 'Account_Program__c', field: 'Account__c', relationshipName: 'Programs__r' },
    ],
  };
  const program: DescribeSObject = {
    name: 'Program__c',
    label: 'Program',
    labelPlural: 'Programs',
    fields: [{ name: 'Id', label: 'Id', type: 'id' }],
    childRelationships: [
      { childSObject: 'Account_Program__c', field: 'Program__c', relationshipName: 'Accounts__r' },
    ],
  };

  it('finds a lookup and the matching child relationship', () => {
    const toAccount = findRelationshipPaths(siteVisit, account);
    expect(toAccount[0]).toMatchObject({
      kind: 'lookup',
      field: 'Account__c',
      relationshipName: 'Account__r',
    });
    const fromAccount = findRelationshipPaths(account, siteVisit);
    expect(fromAccount[0]).toMatchObject({ kind: 'children', relationshipName: 'Site_Visits__r' });
  });

  it('finds a junction object', () => {
    expect(findRelationshipPaths(account, program)).toEqual([
      expect.objectContaining({
        kind: 'junction',
        junctionObject: 'Account_Program__c',
        fromField: 'Account__c',
        toField: 'Program__c',
      }),
    ]);
  });
});
