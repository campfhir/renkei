import {
  hiddenFieldsOf,
  isEmptyPolicy,
  policyFromSettings,
  policyRefusalForQuery,
  recordTypesIn,
  reportNamesHidden,
  scrubRecords,
  soqlIdentifierParts,
  validatePolicy,
  type DataPolicy,
} from './policy';

const policy: DataPolicy = {
  excludedObjects: ['Case_Note__c'],
  excludedFields: ['Contact.Diagnosis__c'],
  hideRestricted: true,
};

describe('validatePolicy', () => {
  it('normalizes lists from text, deduplicating case-insensitively', () => {
    const result = validatePolicy({
      excludedObjects: 'Case_Note__c, case_note__c\nPayroll__c',
      excludedFields: ['Contact.Diagnosis__c'],
      hideRestricted: true,
    });
    expect(result).toEqual({
      ok: true,
      policy: {
        excludedObjects: ['case_note__c', 'Payroll__c'],
        excludedFields: ['Contact.Diagnosis__c'],
        hideRestricted: true,
      },
    });
  });

  it('refuses a field without its object, and a non-name', () => {
    expect(validatePolicy({ excludedFields: 'Diagnosis__c' })).toMatchObject({ ok: false });
    expect(validatePolicy({ excludedObjects: 'Case-Note' })).toMatchObject({ ok: false });
  });

  it('reads saved settings defensively', () => {
    expect(
      policyFromSettings({ excludedObjects: ['Ok__c', 'not ok'], hideRestricted: 'yes' })
    ).toEqual({
      excludedObjects: ['Ok__c'],
      excludedFields: [],
      hideRestricted: false,
    });
    expect(isEmptyPolicy(policyFromSettings(undefined))).toBe(true);
  });
});

describe('hiddenFieldsOf', () => {
  it('joins the listed fields of the object with its restricted ones when the switch is on', () => {
    expect([...hiddenFieldsOf(policy, 'contact', ['SSN__c'])].sort()).toEqual([
      'diagnosis__c',
      'ssn__c',
    ]);
    expect([
      ...hiddenFieldsOf({ ...policy, hideRestricted: false }, 'Contact', ['SSN__c']),
    ]).toEqual(['diagnosis__c']);
    expect([...hiddenFieldsOf(policy, 'Account')]).toEqual([]);
  });
});

describe('policyRefusalForQuery', () => {
  const none = new Map<string, Set<string>>();

  it('refuses a hidden object anywhere, subqueries and relationships included', () => {
    expect(policyRefusalForQuery('SELECT Id FROM Case_Note__c', policy, none)).toMatch(
      /Case_Note__c/
    );
    expect(
      policyRefusalForQuery(
        'SELECT Id, (SELECT Id FROM Case_Notes__r) FROM Contact WHERE Case_Note__c.Id != null',
        policy,
        none
      )
    ).toMatch(/Case_Note__c/);
  });

  it('refuses a hidden field selected or filtered on, through any path', () => {
    expect(
      policyRefusalForQuery('SELECT Id FROM Contact WHERE Diagnosis__c = null', policy, none)
    ).toMatch(/diagnosis__c/);
    expect(policyRefusalForQuery('SELECT Contact.Diagnosis__c FROM Case', policy, none)).toMatch(
      /diagnosis__c/
    );
    const restricted = new Map([['contact', new Set(['ssn__c'])]]);
    expect(policyRefusalForQuery('SELECT SSN__c FROM Contact', policy, restricted)).toMatch(
      /ssn__c/
    );
  });

  it('ignores names inside string literals and allows the rest', () => {
    expect(
      policyRefusalForQuery(
        "SELECT Id, Name FROM Contact WHERE Name = 'Diagnosis__c'",
        policy,
        none
      )
    ).toBeNull();
    expect(
      soqlIdentifierParts("SELECT Account.Owner.Name FROM Contact WHERE x = 'it\\'s'")
    ).toEqual(new Set(['select', 'account', 'owner', 'name', 'from', 'contact', 'where', 'x']));
  });

  it('refuses TYPEOF while objects are hidden', () => {
    expect(
      policyRefusalForQuery(
        'SELECT TYPEOF What WHEN Account THEN Name END FROM Event',
        policy,
        none
      )
    ).toMatch(/TYPEOF/);
  });
});

describe('scrubRecords', () => {
  it('drops hidden fields per type, hidden parents and children, and hidden top-level records', () => {
    const records = [
      {
        attributes: { type: 'Contact' },
        Id: '003',
        Diagnosis__c: 'x',
        Name: 'Ada',
        Account: { attributes: { type: 'Account' }, Name: 'Acme' },
        Note__r: { attributes: { type: 'Case_Note__c' }, Body__c: 'secret' },
        Case_Notes__r: {
          totalSize: 1,
          done: true,
          records: [{ attributes: { type: 'Case_Note__c' }, Id: 'a01' }],
        },
      },
      { attributes: { type: 'Case_Note__c' }, Id: 'a02' },
    ];
    const hidden = new Map([['contact', new Set(['diagnosis__c'])]]);
    expect(recordTypesIn(records)).toEqual(new Set(['Contact', 'Account', 'Case_Note__c']));
    expect(scrubRecords(records, policy, hidden)).toEqual([
      {
        attributes: { type: 'Contact' },
        Id: '003',
        Name: 'Ada',
        Account: { attributes: { type: 'Account' }, Name: 'Acme' },
        Note__r: null,
        Case_Notes__r: { totalSize: 0, done: true, records: [] },
      },
    ]);
  });
});

describe('reportNamesHidden', () => {
  it('matches the parts of a report column name', () => {
    expect(
      reportNamesHidden(policy, [
        'ACCOUNT.NAME',
        'Contact.Diagnosis__c',
        'Case_Note__c.Body__c',
        's!Amount',
      ])
    ).toEqual(['Contact.Diagnosis__c', 'Case_Note__c.Body__c']);
  });
});
