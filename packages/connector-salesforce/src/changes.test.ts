import { metadataFile, metadataFileName } from './metadata-xml';
import {
  layoutBehaviors,
  layoutButtons,
  layoutRelatedLists,
  layoutSections,
  mergeLayoutChanges,
  profileLayoutFile,
} from './layouts';
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

describe('mergeLayoutChanges beyond placing fields', () => {
  const withLists = {
    ...layout,
    relatedLists: [
      { fields: ['FULL_NAME', 'CONTACT.EMAIL'], relatedList: 'RelatedContactList' },
      { relatedList: 'Visit_Note__c.Visit__c' },
    ],
  };

  it('moves a field to another section, keeping how it behaves, and changes how one behaves', () => {
    const merged = mergeLayoutChanges(layout, {
      addSections: [{ label: 'Follow-up', columns: 1 }],
      setBehavior: [{ field: 'stage__c', behavior: 'Readonly' }],
    });
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    const moved = mergeLayoutChanges(merged.layout, {
      move: [{ field: 'name', section: 'follow-up' }],
    });
    if (!moved.ok) throw new Error(moved.errors.join('; '));
    expect(layoutSections(moved.layout).slice(0, 2)).toEqual([
      { label: 'Information', columns: [['Stage__c'], ['OwnerId']] },
      { label: 'Follow-up', columns: [['Name']] },
    ]);
    expect(layoutBehaviors(moved.layout).get('name')).toBe('Required');
    expect(layoutBehaviors(moved.layout).get('stage__c')).toBe('Readonly');
    expect(merged.summary).toContain('Make Stage__c read only here');
    expect(moved.summary).toEqual(['Move Name to “Follow-up”']);
  });

  it('renames a section, and removes one along with the fields in it, saying which', () => {
    const merged = mergeLayoutChanges(layout, {
      renameSections: [{ section: 'custom links', label: 'Links' }],
      removeSections: ['Information'],
    });
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    expect(layoutSections(merged.layout)).toEqual([{ label: 'Links', columns: [[], [], []] }]);
    expect(merged.summary).toEqual([
      'Remove the section “Information”, and with it Name, Stage__c, OwnerId',
      'Rename the section “Custom Links” to “Links”',
    ]);
  });

  it('adds a related list after those there, with its columns, and takes one off', () => {
    const merged = mergeLayoutChanges(withLists, {
      removeRelatedLists: ['relatedcontactlist'],
      addRelatedLists: [{ relatedList: 'Follow_Up__c.Visit__c', fields: ['NAME', 'Due__c'] }],
    });
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    expect(layoutRelatedLists(merged.layout)).toEqual([
      { relatedList: 'Visit_Note__c.Visit__c', fields: [] },
      { relatedList: 'Follow_Up__c.Visit__c', fields: ['NAME', 'Due__c'] },
    ]);
    expect(merged.summary).toEqual([
      'Remove the related list RelatedContactList',
      'Add the related list Follow_Up__c.Visit__c showing NAME, Due__c',
    ]);
    // Sections are untouched by a related-list change.
    expect(layoutSections(merged.layout)).toEqual(layoutSections(layout));
  });

  it('refuses what is not there to change, and what is already so', () => {
    expect(
      mergeLayoutChanges(withLists, {
        move: [
          { field: 'Nope__c', section: 'Information' },
          { field: 'Name', section: 'Information' },
        ],
        setBehavior: [{ field: 'Name', behavior: 'Required' }],
        renameSections: [{ section: 'Information', label: 'Custom Links' }],
        removeSections: ['Elsewhere'],
        addRelatedLists: [{ relatedList: 'RelatedContactList' }],
        removeRelatedLists: ['RelatedCaseList'],
      })
    ).toMatchObject({
      ok: false,
      errors: [
        'This layout has no section “Elsewhere”. Its sections: Information, Custom Links.',
        'This layout already has a section “Custom Links”.',
        'Nope__c is not on this layout.',
        'Name is already in “Information”.',
        'Name is already required on this layout.',
        'This layout has no related list RelatedCaseList. Its related lists: RelatedContactList, Visit_Note__c.Visit__c.',
        'The related list RelatedContactList is already on this layout.',
      ],
    });
  });
});

describe('mergeLayoutChanges: order, related-list columns, buttons and actions', () => {
  it('places a field before or after another, or in a named column, in its own section or another', () => {
    const first = mergeLayoutChanges(layout, { move: [{ field: 'Stage__c', before: 'name' }] });
    if (!first.ok) throw new Error(first.errors.join('; '));
    expect(layoutSections(first.layout)[0].columns).toEqual([['Stage__c', 'Name'], ['OwnerId']]);
    expect(first.summary).toEqual(['Move Stage__c before Name in “Information”']);

    const across = mergeLayoutChanges(layout, {
      move: [
        { field: 'Name', after: 'OwnerId' },
        { field: 'Stage__c', column: 2 },
      ],
    });
    if (!across.ok) throw new Error(across.errors.join('; '));
    expect(layoutSections(across.layout)[0].columns).toEqual([[], ['OwnerId', 'Name', 'Stage__c']]);
    expect(across.summary).toEqual([
      'Move Name after OwnerId in “Information”',
      'Move Stage__c to column 2 in “Information”',
    ]);
  });

  it('refuses a place that is not there', () => {
    expect(
      mergeLayoutChanges(layout, {
        move: [
          { field: 'Name', before: 'Nope__c' },
          { field: 'Name', column: 5 },
          { field: 'Name', before: 'Stage__c', after: 'OwnerId' },
          { field: 'Name', before: 'Name' },
        ],
      })
    ).toMatchObject({
      ok: false,
      errors: [
        'Nope__c is not in “Information” to place Name beside.',
        '“Information” has 2 column(s), not 5.',
        'Name: name before or after, not both.',
        'Name cannot be placed beside itself.',
      ],
    });
  });

  it('replaces a related list’s columns, and adds and removes custom buttons', () => {
    const merged = mergeLayoutChanges(
      {
        ...layout,
        customButtons: ['Print_Visit'],
        relatedLists: [{ fields: ['NAME'], relatedList: 'Visit_Note__c.Visit__c' }],
      },
      {
        setRelatedListColumns: [
          { relatedList: 'visit_note__c.visit__c', fields: ['NAME', 'Body__c'] },
        ],
        addButtons: ['Send_Summary'],
        removeButtons: ['print_visit'],
      }
    );
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    expect(layoutRelatedLists(merged.layout)).toEqual([
      { relatedList: 'Visit_Note__c.Visit__c', fields: ['NAME', 'Body__c'] },
    ]);
    expect(layoutButtons(merged.layout)).toEqual({ buttons: ['Send_Summary'], actions: null });
  });

  it('adds to and removes from the layout’s own action bar, renumbered in order', () => {
    const merged = mergeLayoutChanges(
      {
        ...layout,
        platformActionList: {
          actionListContext: 'Record',
          platformActionListItems: [
            { actionName: 'Edit', actionType: 'StandardButton', sortOrder: 0 },
            { actionName: 'Delete', actionType: 'StandardButton', sortOrder: 1 },
          ],
        },
      },
      { addActions: [{ name: 'Site_Visit__c.Log_Outcome' }], removeActions: ['edit'] }
    );
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    expect(layoutButtons(merged.layout).actions).toEqual(['Delete', 'Site_Visit__c.Log_Outcome']);
    expect(merged.layout.platformActionList).toMatchObject({
      platformActionListItems: [
        { actionName: 'Delete', sortOrder: 0 },
        { actionName: 'Site_Visit__c.Log_Outcome', actionType: 'QuickAction', sortOrder: 1 },
      ],
    });
  });

  it('says a layout on Salesforce’s default actions will show only the ones it is given', () => {
    const merged = mergeLayoutChanges(layout, {
      addActions: [{ name: 'Edit', type: 'StandardButton' }],
    });
    if (!merged.ok) throw new Error(merged.errors.join('; '));
    expect(merged.summary[0]).toContain('will show only the ones listed here');
    expect(mergeLayoutChanges(layout, { removeActions: ['Edit'] })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('no action list of its own')],
    });
  });
});

describe('profileLayoutFile', () => {
  it('holds only the layout assignments, with the record type when one is named', () => {
    const xml = profileLayoutFile([
      { layout: 'Site_Visit__c-Site Visit Layout' },
      { layout: 'Site_Visit__c-Home Layout', recordType: 'Site_Visit__c.Home_Visit' },
    ]);
    expect(xml.match(/<layoutAssignments>/g)).toHaveLength(2);
    expect(xml).toContain('<recordType>Site_Visit__c.Home_Visit</recordType>');
    expect(xml.match(/<recordType>/g)).toHaveLength(1);
    expect(xml).not.toContain('fieldPermissions');
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

describe('mergeFieldChanges on a formula field', () => {
  const reached = {
    type: 'Percent',
    label: 'Reached Initial Call',
    formula: 'IF(ISBLANK(Initial_Call__c), 0, 100)',
    formulaTreatBlanksAs: 'BlankAsZero',
    precision: 18,
    scale: 0,
  };

  it('changes the formula and lists it old → new', () => {
    const merged = mergeFieldChanges(reached, { formula: 'IF(ISBLANK(Initial_Call__c), 0, 1)' });
    expect(merged).toEqual({
      ok: true,
      metadata: { ...reached, formula: 'IF(ISBLANK(Initial_Call__c), 0, 1)' },
      rows: [
        {
          label: 'Formula',
          value: 'IF(ISBLANK(Initial_Call__c), 0, 1)',
          from: 'IF(ISBLANK(Initial_Call__c), 0, 100)',
        },
      ],
    });
    const xml = existingFieldXml('Reached__c', merged.ok ? merged.metadata : {});
    expect(xml).toContain('<formula>IF(ISBLANK(Initial_Call__c), 0, 1)</formula>');
  });

  it('changes what it returns and its digits, which loses nothing', () => {
    const merged = mergeFieldChanges(reached, {
      type: 'Number',
      scale: 2,
      blanksAs: 'BlankAsBlank',
    });
    expect(merged).toMatchObject({
      ok: true,
      metadata: { type: 'Number', precision: 18, scale: 2, formulaTreatBlanksAs: 'BlankAsBlank' },
    });
    const text = mergeFieldChanges(reached, { type: 'Text' });
    expect(text.ok && text.metadata).toEqual({
      type: 'Text',
      label: 'Reached Initial Call',
      formula: 'IF(ISBLANK(Initial_Call__c), 0, 100)',
      formulaTreatBlanksAs: 'BlankAsZero',
    });
    expect(mergeFieldChanges({ ...reached, scale: 2 }, { scale: 0 })).toMatchObject({
      ok: true,
      metadata: { scale: 0 },
    });
  });

  it('refuses a formula on a stored field, an empty or too long formula, and a default', () => {
    const date = { type: 'Date', label: 'Visit Date' };
    expect(mergeFieldChanges(date, { formula: 'TODAY()' })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('not a formula field')],
    });
    expect(mergeFieldChanges(date, { blanksAs: 'BlankAsZero' })).toMatchObject({ ok: false });
    expect(mergeFieldChanges(reached, { formula: '  ' })).toEqual({
      ok: false,
      errors: ['A formula field needs its formula.'],
    });
    expect(mergeFieldChanges(reached, { formula: 'x'.repeat(3901) })).toMatchObject({
      ok: false,
    });
    expect(mergeFieldChanges(reached, { defaultValue: '1' })).toEqual({
      ok: false,
      errors: ['A formula field is calculated: it has no default.'],
    });
    expect(mergeFieldChanges(reached, { type: 'Picklist' })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('A formula field returns one of')],
    });
    expect(mergeFieldChanges(reached, { required: true })).toMatchObject({ ok: false });
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
