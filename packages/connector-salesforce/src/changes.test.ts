import { metadataFile, metadataFileName } from './metadata-xml';
import { layoutSections, mergeLayoutChanges } from './layouts';
import {
  buildObjectPackage,
  checkObjectSpec,
  existingFieldXml,
  mergeFieldChanges,
  mergePicklistChanges,
} from './changes';

describe('metadata XML from Tooling JSON', () => {
  it('writes arrays as repeated elements, drops nulls and Tooling-only keys, escapes text', () => {
    const xml = metadataFile('Layout', {
      urls: null,
      layoutSections: [
        {
          label: 'Info & more',
          layoutColumns: [{ layoutItems: [{ behavior: 'Edit', field: 'Name' }] }],
        },
      ],
      showRunAssignmentRulesCheckbox: false,
      emailDefault: null,
    });
    expect(xml).toContain('<Layout xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(xml).toContain('<label>Info &amp; more</label>');
    expect(xml).toContain('<field>Name</field>');
    expect(xml).toContain('<showRunAssignmentRulesCheckbox>false</showRunAssignmentRulesCheckbox>');
    expect(xml).not.toContain('urls');
    expect(xml).not.toContain('emailDefault');
  });

  it('percent-encodes a component file name the way the Metadata API does', () => {
    expect(metadataFileName('Account-Account (Marketing) Layout')).toBe(
      'Account-Account %28Marketing%29 Layout'
    );
    expect(metadataFileName('Site_Visit__c-Site Visit Layout')).toBe(
      'Site_Visit__c-Site Visit Layout'
    );
  });
});

const layout = {
  layoutSections: [
    {
      label: 'Information',
      style: 'TwoColumnsTopToBottom',
      layoutColumns: [
        {
          layoutItems: [
            { behavior: 'Required', field: 'Name' },
            { behavior: 'Edit', field: 'Stage__c' },
          ],
        },
        { layoutItems: [{ behavior: 'Edit', field: 'OwnerId' }] },
      ],
    },
    { label: 'Custom Links', style: 'CustomLinks', layoutColumns: [{}, {}, {}] },
  ],
};

describe('mergeLayoutChanges', () => {
  it('adds to the shorter column of the first section with fields, removes, and adds sections before the links', () => {
    const merged = mergeLayoutChanges(layout, {
      add: [{ field: 'Outcome__c' }],
      remove: ['Stage__c'],
      addSections: [{ label: 'Follow-up', columns: 1, fields: [{ field: 'Notes__c' }] }],
    });
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    expect(layoutSections(merged.layout)).toEqual([
      { label: 'Information', columns: [['Name', 'Outcome__c'], ['OwnerId']] },
      { label: 'Follow-up', columns: [['Notes__c']] },
      { label: 'Custom Links', columns: [[], [], []] },
    ]);
    expect(merged.summary).toEqual([
      'Remove Stage__c',
      'Add Outcome__c to “Information”',
      'New section “Follow-up” with Notes__c',
    ]);
    // The input is not touched.
    expect(layoutSections(layout)[0].columns[0]).toEqual(['Name', 'Stage__c']);
  });

  it('refuses a field already there, a section that is not, and a field to remove that is not there', () => {
    expect(
      mergeLayoutChanges(layout, {
        add: [{ field: 'name' }, { field: 'X__c', section: 'Nope' }],
        remove: ['Y__c'],
      })
    ).toMatchObject({
      ok: false,
      errors: [
        'Y__c is not on this layout.',
        'name is already on this layout.',
        'This layout has no section “Nope”. Its sections: Information, Custom Links.',
      ],
    });
  });
});

describe('mergeFieldChanges', () => {
  const text = { type: 'Text', label: 'Code', length: 20, required: false, inlineHelpText: null };

  it('merges what changes and lists it old → new', () => {
    const merged = mergeFieldChanges(text, {
      label: 'Program Code',
      length: 40,
      helpText: 'From the intake form',
    });
    expect(merged).toEqual({
      ok: true,
      metadata: {
        type: 'Text',
        label: 'Program Code',
        length: 40,
        required: false,
        inlineHelpText: 'From the intake form',
      },
      rows: [
        { label: 'Label', value: 'Program Code', from: 'Code' },
        { label: 'Help text', value: 'From the intake form', from: '(none)' },
        { label: 'Length', value: '40', from: '20' },
      ],
    });
    const xml = existingFieldXml('Code__c', merged.ok ? merged.metadata : {});
    expect(xml).toContain('<fullName>Code__c</fullName>');
    expect(xml).toContain('<length>40</length>');
  });

  it('refuses what would lose data, a type change, and a change that changes nothing', () => {
    expect(mergeFieldChanges(text, { length: 10 })).toMatchObject({ ok: false });
    expect(mergeFieldChanges(text, { type: 'Number' })).toMatchObject({ ok: false });
    expect(
      mergeFieldChanges({ type: 'Number', precision: 10, scale: 2 }, { precision: 8 })
    ).toMatchObject({
      ok: false,
      errors: ['Fewer digits would cut or round existing values; it is not offered.'],
    });
    expect(
      mergeFieldChanges({ type: 'Checkbox', defaultValue: 'false' }, { required: true })
    ).toMatchObject({ ok: false });
    expect(mergeFieldChanges(text, { label: 'Code' })).toEqual({
      ok: false,
      errors: ['Nothing in that changes the field.'],
    });
  });
});

describe('mergePicklistChanges', () => {
  const picklist = {
    type: 'Picklist',
    valueSet: {
      restricted: true,
      valueSetDefinition: {
        sorted: false,
        value: [
          { fullName: 'Scheduled', default: true, label: 'Scheduled' },
          { fullName: 'Completed', default: false, label: 'Completed' },
          { fullName: 'Legacy', default: false, label: 'Legacy' },
        ],
      },
    },
  };

  it('adds, relabels, deactivates, reorders and sets the default — never deleting a value', () => {
    const merged = mergePicklistChanges(picklist, {
      add: [{ value: 'No show' }],
      relabel: [{ value: 'Completed', label: 'Done' }],
      deactivate: ['Legacy'],
      order: ['Completed', 'Scheduled'],
      defaultValue: 'Completed',
    });
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    const valueSet = merged.metadata.valueSet;
    const definition =
      typeof valueSet === 'object' && valueSet !== null && 'valueSetDefinition' in valueSet
        ? valueSet.valueSetDefinition
        : null;
    const values: Record<string, unknown>[] =
      typeof definition === 'object' &&
      definition !== null &&
      'value' in definition &&
      Array.isArray(definition.value)
        ? definition.value
        : [];
    expect(values.map((v) => [v.fullName, v.label, v.default, v.isActive])).toEqual([
      ['Completed', 'Done', true, undefined],
      ['Scheduled', 'Scheduled', false, undefined],
      ['Legacy', 'Legacy', false, false],
      ['No show', 'No show', false, undefined],
    ]);
    expect(merged.rows.map((row) => row.label)).toEqual([
      'Add value',
      'Label of Completed',
      'Stop offering',
      'Order',
      'Default',
    ]);
  });

  it('sends a global value set’s changes to the set, and refuses unknown values', () => {
    expect(
      mergePicklistChanges(
        { type: 'Picklist', valueSet: { valueSetName: 'Regions' } },
        { add: [{ value: 'West' }] }
      )
    ).toMatchObject({ ok: false });
    expect(mergePicklistChanges(picklist, { deactivate: ['Nope'] })).toMatchObject({
      ok: false,
      errors: ['"Nope" is not a value of this picklist.'],
    });
  });
});

describe('a new custom object', () => {
  it('checks the object and its first fields, and packages the object and a tab', () => {
    const checked = checkObjectSpec(
      {
        label: 'Volunteer Shift',
        nameField: { type: 'AutoNumber', label: 'Shift Number' },
        sharingModel: 'Private',
        fields: [{ label: 'Hours', type: 'Number', scale: 1 }],
      },
      ['Account', 'Contact']
    );
    if (!checked.ok) throw new Error(checked.errors.join('; '));
    expect(checked.value).toMatchObject({
      apiName: 'Volunteer_Shift__c',
      pluralLabel: 'Volunteer Shifts',
      nameField: { type: 'AutoNumber', displayFormat: 'VOL-{0000}', startingNumber: 1 },
    });
    const built = buildObjectPackage(checked.value);
    expect(Object.keys(built.files).sort()).toEqual([
      'objects/Volunteer_Shift__c.object',
      'package.xml',
      'tabs/Volunteer_Shift__c.tab',
    ]);
    expect(built.files['objects/Volunteer_Shift__c.object']).toContain(
      '<sharingModel>Private</sharingModel>'
    );
    expect(built.files['objects/Volunteer_Shift__c.object']).toContain(
      '<fullName>Hours__c</fullName>'
    );
    expect(built.files['tabs/Volunteer_Shift__c.tab']).toContain(
      '<customObject>true</customObject>'
    );
    expect(built.files['package.xml']).toContain('<name>CustomTab</name>');
  });

  it('refuses a clash, a bad sharing model and a bad first field', () => {
    expect(
      checkObjectSpec({ label: 'Account', apiName: 'Volunteer__c' }, ['Volunteer__c'])
    ).toMatchObject({ ok: false });
    expect(checkObjectSpec({ label: 'X', sharingModel: 'ControlledByParent' }, [])).toMatchObject({
      ok: false,
    });
    expect(
      checkObjectSpec({ label: 'X', fields: [{ label: 'Bad', type: 'Formula' }] }, [])
    ).toMatchObject({ ok: false });
  });
});
