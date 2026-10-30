import {
  buildReportPackage,
  buildReportTypePackage,
  checkFilterLogic,
  checkReportSpec,
  checkReportTypeSpec,
  reportableFields,
  reportFileColumn,
  type ReportObjectInfo,
} from './report-metadata';

const VISIT: ReportObjectInfo = {
  name: 'Site_Visit__c',
  labelPlural: 'Site Visits',
  fields: ['Name', 'Id', 'Outcome__c', 'Visit_Date__c'],
  nameField: 'Name',
  lookups: ['Owner', 'Program__r'],
  children: { Visit_Notes__r: 'Visit_Note__c', Histories: 'Site_Visit__History' },
};
const NOTE: ReportObjectInfo = {
  name: 'Visit_Note__c',
  labelPlural: 'Visit Notes',
  fields: ['Name', 'Body__c'],
  nameField: 'Name',
  lookups: [],
  children: {},
};
const objects = (name: string) =>
  [VISIT, NOTE].find((o) => o.name.toLowerCase() === name.toLowerCase());

describe('reportableFields', () => {
  it('puts the name field first and leaves out compound and binary fields', () => {
    expect(
      reportableFields([
        { name: 'Id', type: 'id' },
        { name: 'BillingAddress', type: 'address' },
        { name: 'Name', type: 'string', nameField: true },
        { name: 'Logo__c', type: 'base64' },
      ])
    ).toEqual({ fields: ['Name', 'Id'], nameField: 'Name' });
  });
});

describe('checkReportTypeSpec', () => {
  it('defaults one section per object with every field, the name checked', () => {
    const checked = checkReportTypeSpec(
      {
        label: 'Site Visits with Notes',
        baseObject: 'site_visit__c',
        joins: [{ relationship: 'visit_notes__r', outerJoin: true }],
      },
      objects
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value).toMatchObject({
      developerName: 'Site_Visits_with_Notes',
      description: 'Site Visits with Notes',
      category: 'other',
      baseObject: 'Site_Visit__c',
      joins: [{ relationship: 'Visit_Notes__r', object: 'Visit_Note__c', outerJoin: true }],
      deployed: true,
    });
    expect(checked.value.sections.map((s) => [s.label, s.table])).toEqual([
      ['Site Visits', 'Site_Visit__c'],
      ['Visit Notes', 'Site_Visit__c.Visit_Notes__r'],
    ]);
    expect(checked.value.sections[0].columns[0]).toEqual({ field: 'Name', checked: true });
    expect(checked.value.sections[0].columns[1]).toEqual({ field: 'Id', checked: false });

    const { files, members } = buildReportTypePackage(checked.value);
    expect(members).toEqual([{ type: 'ReportType', member: 'Site_Visits_with_Notes' }]);
    const xml = files['reportTypes/Site_Visits_with_Notes.reportType'];
    expect(xml).toContain('<baseObject>Site_Visit__c</baseObject>');
    expect(xml).toMatch(
      /<join>\s*<outerJoin>true<\/outerJoin>\s*<relationship>Visit_Notes__r<\/relationship>\s*<\/join>/
    );
    expect(xml).toContain('<table>Site_Visit__c.Visit_Notes__r</table>');
    // The schema's order: baseObject, category, deployed, description, join, label, sections.
    const order = [
      'baseObject',
      'category',
      'deployed',
      'description',
      'join',
      'label',
      'sections',
    ];
    const at = order.map((tag) => xml.indexOf(`<${tag}>`));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('takes named sections with lookup paths, and refuses what does not resolve', () => {
    const checked = checkReportTypeSpec(
      {
        label: 'Visits',
        baseObject: 'Site_Visit__c',
        sections: [
          {
            object: 'Site_Visit__c',
            label: 'Visit',
            fields: ['Name', 'owner.Email', 'Outcome__c'],
            checked: ['Outcome__c'],
          },
        ],
      },
      objects
    );
    expect(checked.ok && checked.value.sections[0].columns).toEqual([
      { field: 'Name', checked: false },
      { field: 'Owner.Email', checked: false },
      { field: 'Outcome__c', checked: true },
    ]);

    const refused = checkReportTypeSpec(
      {
        label: 'Bad',
        baseObject: 'Site_Visit__c',
        joins: [{ relationship: 'Visit_Notes__r', outerJoin: true }, { relationship: 'Nope__r' }],
        sections: [{ object: 'Site_Visit__c', fields: ['Missing__c'] }],
      },
      objects
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors.join('\n')).toContain('Visit_Note__c has no child relationship Nope__r');
    expect(refused.errors.join('\n')).toContain('Site_Visit__c has no field Missing__c');
    expect(checkReportTypeSpec({ label: 'X', baseObject: 'Nothing__c' }, objects)).toEqual({
      ok: false,
      errors: ['There is no object Nothing__c to report on.'],
    });
  });

  it('refuses an inner join after an outer one', () => {
    const deep: ReportObjectInfo = { ...NOTE, children: { Replies__r: 'Site_Visit__c' } };
    const result = checkReportTypeSpec(
      {
        label: 'Deep',
        baseObject: 'Site_Visit__c',
        joins: [
          { relationship: 'Visit_Notes__r', outerJoin: true },
          { relationship: 'Replies__r', outerJoin: false },
        ],
      },
      (name) => (name === 'Visit_Note__c' ? deep : objects(name))
    );
    expect(result.ok === false && result.errors[0]).toContain(
      'an inner join cannot follow an outer one'
    );
  });
});

describe('checkFilterLogic', () => {
  it('takes numbered logic that uses every filter, and nothing else', () => {
    expect(checkFilterLogic('1 AND (2 OR 3)', 3)).toBeNull();
    expect(checkFilterLogic('1 AND 4', 2)).toContain('names filter 4');
    expect(checkFilterLogic('1 AND (2', 2)).toContain('parentheses');
    expect(checkFilterLogic('1', 2)).toContain('every filter');
    expect(checkFilterLogic('1 XOR 2', 2)).toContain('"XOR"');
  });
});

describe('checkReportSpec', () => {
  const summary = {
    name: 'Visits by Outcome',
    reportType: 'Site_Visits__c',
    format: 'Summary',
    columns: [
      { field: 'Site_Visit__c$Name' },
      { field: 'Site_Visit__c$Outcome__c' },
      { field: 'Site_Visit__c$Visit_Hours__c', aggregates: ['Sum', 'Average'] },
    ],
    groupingsDown: [{ field: 'Site_Visit__c$Outcome__c', sortOrder: 'Desc' }],
    filters: [
      { column: 'Site_Visit__c$Outcome__c', operator: 'notEqual', value: 'Cancelled' },
      { column: 'Site_Visit__c$Visit_Hours__c', operator: 'greaterThan', value: '0' },
    ],
    filterLogic: '1 AND 2',
    dateFilter: { column: 'Site_Visit__c$Visit_Date__c', interval: 'INTERVAL_CURRENTQ' },
    scope: 'organization',
  };

  it('builds a summary report in a new folder, the grouped field not a column too', () => {
    const checked = checkReportSpec(summary, { create: { label: 'Program Reports' } });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.developerName).toBe('Visits_by_Outcome');
    expect(checked.value.columns.map((c) => c.field)).toEqual([
      'Site_Visit__c$Name',
      'Site_Visit__c$Visit_Hours__c',
    ]);
    const { files, members } = buildReportPackage(checked.value);
    expect(members).toEqual([
      { type: 'Report', member: 'Program_Reports' },
      { type: 'Report', member: 'Program_Reports/Visits_by_Outcome' },
    ]);
    expect(files['reports/Program_Reports-meta.xml']).toContain('<accessType>Public</accessType>');
    expect(files['reports/Program_Reports-meta.xml']).toContain(
      '<publicFolderAccess>ReadOnly</publicFolderAccess>'
    );
    const xml = files['reports/Program_Reports/Visits_by_Outcome.report'];
    expect(xml).toContain('<aggregateTypes>Sum</aggregateTypes>');
    expect(xml).toContain('<booleanFilter>1 AND 2</booleanFilter>');
    expect(xml).toContain('<interval>INTERVAL_CURRENTQ</interval>');
    expect(xml).toContain('<reportType>Site_Visits__c</reportType>');
    expect(xml).not.toContain('<startDate>');
    const order = [
      'columns',
      'filter',
      'format',
      'groupingsDown',
      'name',
      'reportType',
      'scope',
      'showDetails',
      'timeFrameFilter',
    ];
    const at = order.map((tag) => xml.indexOf(`<${tag}>`));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('puts a report in an existing folder without deploying the folder', () => {
    const checked = checkReportSpec(
      { name: 'All Visits', reportType: 'Site_Visits__c', columns: ['Site_Visit__c$Name'] },
      { existing: 'Program_Reports' }
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const { files, members } = buildReportPackage(checked.value);
    expect(members).toEqual([{ type: 'Report', member: 'Program_Reports/All_Visits' }]);
    expect(Object.keys(files).sort()).toEqual([
      'package.xml',
      'reports/Program_Reports/All_Visits.report',
    ]);
  });

  it('refuses groupings that do not fit the format, and a custom range without dates', () => {
    const tabular = checkReportSpec(
      { ...summary, format: 'Tabular', dateFilter: { column: 'X', interval: 'INTERVAL_CUSTOM' } },
      { existing: 'F' }
    );
    expect(tabular.ok).toBe(false);
    if (tabular.ok) return;
    expect(tabular.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('A tabular report has no groupings'),
        'A custom date range has a start, an end, or both.',
      ])
    );
    const matrix = checkReportSpec({ ...summary, format: 'Matrix' }, { existing: 'F' });
    expect(matrix.ok === false && matrix.errors).toEqual([
      'A matrix report groups both rows and columns, by at least one field each.',
    ]);
  });
});

describe('reportFileColumn', () => {
  const children: Record<string, Record<string, string>> = {
    Referral: {},
    Site_Visit__c: { Visit_Notes__r: 'Visit_Note__c' },
    Visit_Note__c: { Replies__r: 'Reply__c' },
  };
  const childrenOf = (object: string) => children[object];

  it('puts the $ after the table, keeping a lookup path in the field', () => {
    expect(reportFileColumn('Referral.Name', childrenOf)).toBe('Referral$Name');
    expect(reportFileColumn('Referral.Client.Name', childrenOf)).toBe('Referral$Client.Name');
    expect(reportFileColumn('Referral.Client.Medicare__pc', childrenOf)).toBe(
      'Referral$Client.Medicare__pc'
    );
    expect(reportFileColumn('Referral.Client__c.Name', childrenOf)).toBe('Referral$Client__c.Name');
  });

  it('follows child relationships down into the table, but never into the last part', () => {
    expect(reportFileColumn('Site_Visit__c.Visit_Notes__r.Name', childrenOf)).toBe(
      'Site_Visit__c.Visit_Notes__r$Name'
    );
    expect(reportFileColumn('Site_Visit__c.visit_notes__r.Owner.Email', childrenOf)).toBe(
      'Site_Visit__c.Visit_Notes__r$Owner.Email'
    );
    expect(reportFileColumn('Site_Visit__c.Visit_Notes__r.Replies__r.Body__c', childrenOf)).toBe(
      'Site_Visit__c.Visit_Notes__r.Replies__r$Body__c'
    );
    expect(reportFileColumn('Site_Visit__c.Visit_Notes__r', childrenOf)).toBe(
      'Site_Visit__c$Visit_Notes__r'
    );
  });

  it('leaves a name already in the file’s form, and an unknown object’s table at its first part', () => {
    expect(reportFileColumn('Referral$Client.Name', childrenOf)).toBe('Referral$Client.Name');
    expect(reportFileColumn('Unknown__c.Owner.Email', childrenOf)).toBe('Unknown__c$Owner.Email');
  });
});
