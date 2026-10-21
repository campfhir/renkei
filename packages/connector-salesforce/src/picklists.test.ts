import {
  availableValueName,
  fieldsOfValueSet,
  mergeBusinessProcessValues,
  mergeGlobalValueSetChanges,
  mergeRecordTypePicklist,
  mergeStandardValueSetChanges,
  processOf,
  standardValueSetOf,
} from './picklists';

describe('global value sets', () => {
  const set = {
    masterLabel: 'Regions',
    sorted: false,
    customValue: [
      { fullName: 'North', default: true, label: 'North' },
      { fullName: 'South', default: false, label: 'South' },
    ],
  };

  it('adds, deactivates and changes the default, never deleting', () => {
    const merged = mergeGlobalValueSetChanges(set, {
      add: [{ value: 'East' }],
      deactivate: ['South'],
      defaultValue: 'East',
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const values: unknown = merged.metadata.customValue;
    expect(
      (Array.isArray(values) ? values : []).map((v: Record<string, unknown>) => [
        v.fullName,
        v.default,
        v.isActive,
      ])
    ).toEqual([
      ['North', false, undefined],
      ['South', false, false],
      ['East', true, undefined],
    ]);
    expect(merged.rows.map((r) => r.label)).toEqual(['Add value', 'Stop offering', 'Default']);
    // The read is untouched.
    expect(set.customValue).toHaveLength(2);
  });

  it('refuses an inactive default and a change that changes nothing', () => {
    expect(
      mergeGlobalValueSetChanges(
        { customValue: [{ fullName: 'A', isActive: false }] },
        { defaultValue: 'A' }
      )
    ).toMatchObject({ ok: false, errors: [expect.stringContaining('inactive')] });
    expect(mergeGlobalValueSetChanges(set, { defaultValue: 'North' })).toMatchObject({
      ok: false,
      errors: ['Nothing in that changes the value set.'],
    });
  });
});

describe('standard value sets', () => {
  it('knows which fields share a set, and which a process controls', () => {
    expect(standardValueSetOf('lead', 'leadsource')).toBe('LeadSource');
    expect(fieldsOfValueSet('LeadSource')).toEqual([
      'Contact.LeadSource',
      'Lead.LeadSource',
      'Opportunity.LeadSource',
    ]);
    expect(standardValueSetOf('Account', 'Name')).toBeNull();
    expect(processOf('Opportunity', 'StageName')).toBe('sales process');
    expect(processOf('Opportunity', 'Type')).toBeNull();
  });

  it('needs a new stage’s probability and forecast category, and keeps the others’ flags', () => {
    const read = [
      {
        value: 'Prospecting',
        label: 'Prospecting',
        default: true,
        flags: { closed: false, won: false, probability: 10, forecastCategory: 'Pipeline' },
      },
    ];
    expect(
      mergeStandardValueSetChanges('OpportunityStage', read, { add: [{ value: 'Pilot' }] })
    ).toMatchObject({
      ok: false,
      errors: ['"Pilot": a new stage needs its probability, 0 to 100.'],
    });
    const merged = mergeStandardValueSetChanges('OpportunityStage', read, {
      add: [{ value: 'Signed', probability: 100, forecastCategory: 'Closed', won: true }],
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.metadata.standardValue).toEqual([
      {
        fullName: 'Prospecting',
        default: true,
        label: 'Prospecting',
        closed: false,
        won: false,
        probability: 10,
        forecastCategory: 'Pipeline',
      },
      {
        fullName: 'Signed',
        default: false,
        label: 'Signed',
        closed: true,
        forecastCategory: 'Closed',
        probability: 100,
        won: true,
      },
    ]);
  });

  it('marks a new lead status converted or not', () => {
    const merged = mergeStandardValueSetChanges(
      'LeadStatus',
      [{ value: 'Open', label: 'Open', default: true, flags: { converted: false } }],
      { add: [{ value: 'Qualified', converted: true }] }
    );
    expect(merged.ok && merged.metadata.standardValue).toContainEqual(
      expect.objectContaining({ fullName: 'Qualified', converted: true })
    );
  });
});

describe('record types and business processes', () => {
  const recordType = {
    label: 'Home Visit',
    active: true,
    picklistValues: [
      {
        picklist: 'Stage__c',
        values: [
          { fullName: 'Draft', default: true },
          { fullName: 'Closed%2FDone', default: false },
        ],
      },
    ],
  };
  const known = ['Draft', 'Closed/Done', 'Cancelled'];

  it('offers and removes values by their decoded names, encoding new ones', () => {
    expect(availableValueName('Closed/Done')).toBe('Closed%2FDone');
    const merged = mergeRecordTypePicklist(
      recordType,
      'Stage__c',
      { add: ['cancelled'], remove: ['Closed/Done'], defaultValue: 'Cancelled' },
      known
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.metadata.picklistValues).toEqual([
      expect.objectContaining({ picklist: 'Stage__c' }),
    ]);
    const picklists: unknown = merged.metadata.picklistValues;
    expect(Array.isArray(picklists) && picklists[0].values).toEqual([
      { fullName: 'Draft', default: false },
      { fullName: 'Cancelled', default: true },
    ]);
    expect(merged.rows).toEqual([
      { label: 'Default', value: 'Cancelled', from: 'Draft' },
      { label: 'Offer', value: 'Cancelled' },
      { label: 'Stop offering', value: 'Closed/Done' },
    ]);
  });

  it('refuses a picklist the record type does not list, and leaving one empty', () => {
    expect(mergeRecordTypePicklist(recordType, 'Outcome__c', { add: ['Draft'] }, known)).toEqual({
      ok: false,
      errors: ['Record type Home Visit does not list Outcome__c.'],
    });
    expect(
      mergeRecordTypePicklist(recordType, 'Stage__c', { remove: ['Draft', 'Closed/Done'] }, known)
    ).toMatchObject({ ok: false, errors: [expect.stringContaining('at least one value')] });
    expect(
      mergeRecordTypePicklist(recordType, 'Stage__c', { add: ['Draft'] }, known)
    ).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('already offers exactly that')],
    });
  });

  it('changes a business process’s values the same way', () => {
    const merged = mergeBusinessProcessValues(
      { isActive: true, values: [{ fullName: 'Prospecting', default: true }] },
      'Nonprofit Sales',
      { add: ['Pledged'] },
      ['Prospecting', 'Pledged']
    );
    expect(merged.ok && merged.metadata.values).toEqual([
      { fullName: 'Prospecting', default: true },
      { fullName: 'Pledged', default: false },
    ]);
  });
});
