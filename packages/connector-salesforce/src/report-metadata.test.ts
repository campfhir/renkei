import {
  buildReportPackage,
  buildReportTypePackage,
  checkFilterLogic,
  checkReportSpec,
  checkReportTypeSpec,
  reportableFields,
  reportFileColumn,
  reportFileColumnsFromLayout,
  mergeReportTypeColumns,
  editReport,
  editReportType,
  relativeDateLiteral,
  relativeDateWords,
  reportTypeTables,
  type ReportObjectInfo,
} from './report-metadata';
import { isRecord } from '@renkei/guards';

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

describe('reportFileColumnsFromLayout', () => {
  it('names each column table$field from the layout, a lookup by itself', () => {
    const layout = [
      { table: 'Referral', field: 'Name' },
      { table: 'Referral', field: 'Client__c' },
      { table: 'Referral', field: 'CreatedBy' },
      { table: 'Referral', field: 'Client.Medicare_Status__c' },
      { table: 'Account.Referrals1__r', field: 'Referral_Stage__c' },
    ];
    expect(
      Object.fromEntries(
        reportFileColumnsFromLayout(
          [
            'Referral.Name',
            'Referral.Client__c.Name',
            'Referral.CreatedBy.Name',
            'Referral.Client.Medicare_Status__c',
            'Account.Referrals1__r.Referral_Stage__c',
            'Referral.Unknown__c',
            'Referral.Client__c.Phone',
          ],
          layout
        )
      )
    ).toEqual({
      'Referral.Name': 'Referral$Name',
      'Referral.Client__c.Name': 'Referral$Client__c',
      'Referral.CreatedBy.Name': 'Referral$CreatedBy',
      'Referral.Client.Medicare_Status__c': 'Referral$Client.Medicare_Status__c',
      'Account.Referrals1__r.Referral_Stage__c': 'Account.Referrals1__r$Referral_Stage__c',
    });
  });

  it('takes the related name field it is given, and never another field of the lookup', () => {
    const layout = [{ table: 'Referral', field: 'Case' }];
    const names = reportFileColumnsFromLayout(
      ['Referral.Case.CaseNumber', 'Referral.Case.Name'],
      layout,
      (table, field) => (table === 'Referral' && field === 'Case' ? 'CaseNumber' : undefined)
    );
    expect(Object.fromEntries(names)).toEqual({ 'Referral.Case.CaseNumber': 'Referral$Case' });
  });
});

describe('reportFileColumnsFromLayout, a table joined down from the base', () => {
  // Client Accounts with Referrals: Account, then Referral through
  // Referrals1__r. The describe names Referral's columns by the object.
  const layout = [
    { table: 'Account', field: 'Name' },
    { table: 'Account.Referrals1__r', field: 'Name' },
    { table: 'Account.Referrals1__r', field: 'Referral_Stage__c' },
    { table: 'Account.Referrals1__r', field: 'Client__c' },
  ];
  const objectOf = (table: string) =>
    ({ account: 'Account', 'account.referrals1__r': 'Referral' })[table.toLowerCase()];

  it('names its columns by the join path, matched by the object the describe uses', () => {
    expect(
      Object.fromEntries(
        reportFileColumnsFromLayout(
          [
            'Account.Name',
            'Referral.Name',
            'Referral.Referral_Stage__c',
            'Referral.Client__c.Name',
          ],
          layout,
          undefined,
          objectOf
        )
      )
    ).toEqual({
      'Account.Name': 'Account$Name',
      'Referral.Name': 'Account.Referrals1__r$Name',
      'Referral.Referral_Stage__c': 'Account.Referrals1__r$Referral_Stage__c',
      'Referral.Client__c.Name': 'Account.Referrals1__r$Client__c',
    });
  });

  it('does not guess when two tables are the same object', () => {
    const selfJoin = [
      { table: 'Account', field: 'Name' },
      { table: 'Account.ChildAccounts', field: 'Name' },
    ];
    const names = reportFileColumnsFromLayout(
      ['Account.Name'],
      selfJoin,
      undefined,
      () => 'Account'
    );
    // Account.Name is the base table's own name, never the child's.
    expect(Object.fromEntries(names)).toEqual({ 'Account.Name': 'Account$Name' });
  });
});

describe('reportableFields', () => {
  it('puts the name field first and leaves out compound and binary fields', () => {
    expect(
      reportableFields([
        { name: 'Id', type: 'id' },
        { name: 'BillingAddress', type: 'address' },
        { name: 'Name', type: 'string', nameField: true },
        { name: 'Logo__c', type: 'base64' },
        { name: 'OwnerId', type: 'reference', referenceTo: ['Group', 'User'] },
        { name: 'CreatedById', type: 'reference', referenceTo: ['User'] },
      ])
    ).toEqual({ fields: ['Name', 'Id', 'CreatedById'], nameField: 'Name' });
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

describe('a relative date range', () => {
  const report = {
    name: 'Referrals, rolling year',
    reportType: 'Referrals__c',
    columns: ['Referral$Name'],
  };

  it('reads the value a filter takes, or the words for it, and nothing else', () => {
    expect(relativeDateLiteral('LAST_N_MONTHS:12')).toBe('LAST_N_MONTHS:12');
    expect(relativeDateLiteral('last 12 months')).toBe('LAST_N_MONTHS:12');
    expect(relativeDateLiteral('Last N Days: 365')).toBe('LAST_N_DAYS:365');
    expect(relativeDateLiteral('30 days ago')).toBe('N_DAYS_AGO:30');
    expect(relativeDateLiteral('this fiscal year')).toBe('THIS_FISCAL_YEAR');
    expect(relativeDateLiteral('LAST_N_MONTHS:0')).toBeNull();
    expect(relativeDateLiteral('LAST_N_FORTNIGHTS:2')).toBeNull();
    expect(relativeDateLiteral('2025-11-11')).toBeNull();
    expect(relativeDateWords('LAST_N_MONTHS:12')).toBe('last 12 months');
    expect(relativeDateWords('N_DAYS_AGO:30')).toBe('30 days ago');
    expect(relativeDateWords('THIS_YEAR')).toBe('this year');
  });

  it('is saved as a filter on the date column, with no fixed time frame', () => {
    const checked = checkReportSpec(
      { ...report, dateFilter: { column: 'Referral$CreatedDate', relative: 'last 12 months' } },
      { existing: 'F' }
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.dateFilter).toEqual({
      column: 'Referral$CreatedDate',
      interval: 'INTERVAL_CUSTOM',
      relative: 'LAST_N_MONTHS:12',
    });
    const xml = buildReportPackage(checked.value).files['reports/F/Referrals_rolling_year.report'];
    expect(xml).toMatch(
      /<column>Referral\$CreatedDate<\/column>[\s\S]*<operator>equals<\/operator>\s*<value>LAST_N_MONTHS:12<\/value>/
    );
    expect(xml).not.toContain('<timeFrameFilter>');
    expect(xml).not.toContain('<booleanFilter>');
  });

  it('is ANDed with the filter logic the report already has', () => {
    const checked = checkReportSpec(
      {
        ...report,
        filters: [
          { column: 'Referral$Status', operator: 'equals', value: 'Open' },
          { column: 'Referral$Status', operator: 'equals', value: 'Held' },
        ],
        filterLogic: '1 OR 2',
        dateFilter: { column: 'Referral$CreatedDate', relative: 'LAST_N_DAYS:365' },
      },
      { existing: 'F' }
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const xml = buildReportPackage(checked.value).files['reports/F/Referrals_rolling_year.report'];
    expect(xml).toContain('<booleanFilter>(1 OR 2) AND 3</booleanFilter>');
    expect(xml.match(/<criteriaItems>/g)).toHaveLength(3);
  });

  it('refuses a range that is not one, and one given with an interval or dates too', () => {
    const unknown = checkReportSpec(
      { ...report, dateFilter: { column: 'Referral$CreatedDate', relative: 'the past while' } },
      { existing: 'F' }
    );
    expect(unknown.ok === false && unknown.errors[0]).toContain(
      '"the past while" is not a relative date range'
    );
    const both = checkReportSpec(
      {
        ...report,
        dateFilter: {
          column: 'Referral$CreatedDate',
          relative: 'LAST_N_MONTHS:12',
          start: '2025-11-11',
        },
      },
      { existing: 'F' }
    );
    expect(both.ok === false && both.errors).toEqual([
      'A date range is relative, an interval, or start and end dates: one of them.',
    ]);
  });
});

describe('mergeReportTypeColumns', () => {
  const live = {
    fullName: 'Referrals',
    baseObject: 'Referral',
    category: 'other',
    deployed: 'true',
    label: 'Referrals',
    sections: [
      {
        columns: [
          { checkedByDefault: 'true', field: 'Name', table: 'Referral' },
          {
            checkedByDefault: 'false',
            displayNameOverride: 'Stage',
            field: 'Referral_Stage__c',
            table: 'Referral',
          },
        ],
        masterLabel: 'Referrals',
      },
      {
        columns: {
          checkedByDefault: 'false',
          field: 'Client.Medicare_Status__c',
          table: 'Referral',
        },
        masterLabel: 'Account',
      },
    ],
  };

  it('adds to a section and makes a new one, keeping everything else exactly as read', () => {
    const merged = mergeReportTypeColumns(live, [
      { section: 'account', table: 'Referral', field: 'Client.Medicare__pc', checked: false },
      { section: 'Account', table: 'referral', field: 'Client.Medi_Cal__pc', checked: true },
      { section: 'Programs', table: 'Referral', field: 'Program.Name', checked: false },
    ]);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.metadata.sections).toEqual([
      live.sections[0],
      {
        columns: [
          { checkedByDefault: 'false', field: 'Client.Medicare_Status__c', table: 'Referral' },
          { checkedByDefault: 'false', field: 'Client.Medicare__pc', table: 'Referral' },
          { checkedByDefault: 'true', field: 'Client.Medi_Cal__pc', table: 'Referral' },
        ],
        masterLabel: 'Account',
      },
      {
        columns: [{ checkedByDefault: 'false', field: 'Program.Name', table: 'Referral' }],
        masterLabel: 'Programs',
      },
    ]);
    expect(merged.rows).toEqual([
      {
        label: 'Section “Account”',
        value: 'adds Client.Medicare__pc, Client.Medi_Cal__pc (shown by default)',
      },
      { label: 'Section “Programs”', value: 'adds Program.Name' },
    ]);
    // The read is untouched.
    expect(live.sections[1].columns).not.toBeInstanceOf(Array);
  });

  it('refuses a column already offered, a table the type does not join, and nothing at all', () => {
    const refused = mergeReportTypeColumns(live, [
      { section: 'Account', table: 'Referral', field: 'client.medicare_status__c', checked: false },
      { section: 'Account', table: 'Referral.Notes__r', field: 'Body__c', checked: false },
    ]);
    expect(refused.ok === false && refused.errors).toEqual([
      'client.medicare_status__c (Referral) is already in the section “Account”.',
      'Body__c: the report type’s tables are Referral, not Referral.Notes__r.',
    ]);
    expect(mergeReportTypeColumns(live, [])).toEqual({
      ok: false,
      errors: ['Nothing in that changes the report type.'],
    });
  });

  it('knows the tables of a type that joins down', () => {
    expect(
      reportTypeTables({
        baseObject: 'Account',
        join: {
          join: { outerJoin: 'false', relationship: 'Notes__r' },
          outerJoin: 'true',
          relationship: 'Referrals1__r',
        },
      })
    ).toEqual(['Account', 'Account.Referrals1__r', 'Account.Referrals1__r.Notes__r']);
  });
});

describe('editReportType', () => {
  const live = {
    baseObject: 'Referral',
    category: 'other',
    deployed: 'true',
    description: 'Referrals',
    label: 'Referrals',
    sections: [
      {
        columns: [
          { checkedByDefault: 'true', field: 'Name', table: 'Referral' },
          { checkedByDefault: 'false', field: 'Referral_Stage__c', table: 'Referral' },
        ],
        masterLabel: 'Referrals',
      },
      {
        columns: {
          checkedByDefault: 'false',
          field: 'Client.Medicare_Status__c',
          table: 'Referral',
        },
        masterLabel: 'Account',
      },
    ],
  };

  it('takes a field out, and its section with it when that was the last one', () => {
    const edited = editReportType(live, {
      removes: [
        { table: 'referral', field: 'referral_stage__c' },
        { table: 'Referral', field: 'Client.Medicare_Status__c' },
      ],
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.metadata.sections).toEqual([
      {
        columns: [{ checkedByDefault: 'true', field: 'Name', table: 'Referral' }],
        masterLabel: 'Referrals',
      },
    ]);
    expect(edited.rows).toEqual([
      {
        label: 'Section “Referrals”',
        value: 'takes out referral_stage__c — reports showing it lose that column',
      },
      {
        label: 'Section “Account”',
        value:
          'takes out Client.Medicare_Status__c; the section, now empty, goes too — reports showing it lose that column',
      },
    ]);
  });

  it('renames, re-describes and takes it out of use, adding in the same change', () => {
    const edited = editReportType(live, {
      label: 'PACE Referrals',
      description: 'Referrals with Medi-Cal status',
      deployed: false,
      adds: [
        {
          section: 'Account',
          table: 'Referral',
          field: 'Client.PersonContact.Does_the_Candidate_Have_Medi_Cal__c',
          checked: false,
        },
      ],
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.metadata).toMatchObject({
      label: 'PACE Referrals',
      description: 'Referrals with Medi-Cal status',
      deployed: 'false',
    });
    // The elements stay in the order they were read in.
    expect(Object.keys(edited.metadata)).toEqual(Object.keys(live));
    expect(edited.rows.map((row) => row.label)).toEqual([
      'Label',
      'Description',
      'Available to users',
      'Section “Account”',
    ]);
  });

  it('puts a description the read did not carry where the schema has it', () => {
    const { description: _gone, ...bare } = live;
    const edited = editReportType(bare, { description: 'Now described' });
    expect(edited.ok && Object.keys(edited.metadata)).toEqual(Object.keys(live));
  });

  it('refuses a field it does not offer, its last column, and what is already so', () => {
    const absent = editReportType(live, { removes: [{ table: 'Referral', field: 'Nope__c' }] });
    expect(absent.ok === false && absent.errors).toEqual([
      'Nope__c (Referral) is not in the report type, so it cannot be taken out.',
    ]);
    const all = editReportType(live, {
      removes: [
        { table: 'Referral', field: 'Name' },
        { table: 'Referral', field: 'Referral_Stage__c' },
        { table: 'Referral', field: 'Client.Medicare_Status__c' },
      ],
    });
    expect(all.ok === false && all.errors).toEqual([
      'A report type with no columns offers nothing to report on.',
    ]);
    expect(editReportType(live, { label: 'Referrals', deployed: true })).toEqual({
      ok: false,
      errors: ['Nothing in that changes the report type.'],
    });
  });
});

describe('editReport', () => {
  const live = {
    chart: { chartType: 'HorizontalBar' },
    columns: [{ field: 'Referral$Name' }, { aggregateTypes: 'Sum', field: 'Referral$Age__c' }],
    filter: {
      booleanFilter: '1 OR 2',
      criteriaItems: [
        { column: 'Referral$Status', operator: 'equals', value: 'Open' },
        { column: 'Referral$Status', operator: 'equals', value: 'Held' },
      ],
    },
    format: 'Tabular',
    name: 'Enrollments',
    reportType: 'Referrals__c',
    showDetails: 'true',
    timeFrameFilter: {
      dateColumn: 'Referral$CreatedDate',
      interval: 'INTERVAL_CUSTOM',
      startDate: '2025-11-11',
    },
  };
  const filterOf = (metadata: Record<string, unknown>) => {
    const filter = isRecord(metadata.filter) ? metadata.filter : {};
    const items: unknown[] = Array.isArray(filter.criteriaItems) ? filter.criteriaItems : [];
    return {
      booleanFilter: filter.booleanFilter,
      criteriaItems: items.map((item) => (isRecord(item) ? item : {})),
    };
  };

  it('adds a column and takes one off, keeping what it does not name', () => {
    const edited = editReport(live, {
      addColumns: [{ field: 'Referral$Client_has_Medi_Cal2__c' }],
      removeColumns: ['referral$age__c'],
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.metadata.columns).toEqual([
      { field: 'Referral$Name' },
      { aggregateTypes: null, field: 'Referral$Client_has_Medi_Cal2__c' },
    ]);
    expect(edited.metadata.chart).toEqual(live.chart);
    expect(edited.metadata.filter).toEqual(live.filter);
    expect(Object.keys(edited.metadata)).toEqual(Object.keys(live));
    expect(edited.rows).toEqual([
      { label: 'Columns taken off', value: 'referral$age__c' },
      { label: 'Columns added', value: 'Referral$Client_has_Medi_Cal2__c' },
    ]);
  });

  it('makes a fixed cutoff roll: a filter ANDed with the logic, the time frame gone', () => {
    const edited = editReport(live, {
      dateFilter: { column: 'Referral$CreatedDate', relative: 'last 365 days' },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(filterOf(edited.metadata).booleanFilter).toBe('(1 OR 2) AND 3');
    expect(filterOf(edited.metadata).criteriaItems[2]).toMatchObject({
      column: 'Referral$CreatedDate',
      operator: 'equals',
      value: 'LAST_N_DAYS:365',
    });
    expect(edited.metadata.timeFrameFilter).toBeNull();

    // A second change of the range takes the first one's place.
    const again = editReport(edited.metadata, {
      dateFilter: { column: 'Referral$CreatedDate', relative: 'LAST_N_MONTHS:12' },
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(filterOf(again.metadata).booleanFilter).toBe('(1 OR 2) AND 3');
    expect(filterOf(again.metadata).criteriaItems.map((item) => item.value)).toEqual([
      'Open',
      'Held',
      'LAST_N_MONTHS:12',
    ]);

    // And fixed dates put the time frame back, the rolling filter gone.
    const fixed = editReport(edited.metadata, {
      dateFilter: { column: 'Referral$CreatedDate', start: '2026-01-01' },
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(filterOf(fixed.metadata).booleanFilter).toBe('1 OR 2');
    expect(filterOf(fixed.metadata).criteriaItems).toHaveLength(2);
    expect(fixed.metadata.timeFrameFilter).toEqual({
      dateColumn: 'Referral$CreatedDate',
      endDate: null,
      interval: 'INTERVAL_CUSTOM',
      startDate: '2026-01-01',
    });
  });

  it('replaces the filters whole, or adds to them under the logic it has', () => {
    const replaced = editReport(live, {
      filters: [{ column: 'Referral$Status', operator: 'equals', value: 'Enrolled' }],
    });
    expect(replaced.ok && filterOf(replaced.metadata)).toMatchObject({
      booleanFilter: null,
      criteriaItems: [{ value: 'Enrolled' }],
    });
    const added = editReport(live, {
      addFilters: [{ column: 'Referral$Age__c', operator: 'greaterThan', value: '55' }],
    });
    expect(added.ok && filterOf(added.metadata).booleanFilter).toBe('(1 OR 2) AND 3');
  });

  it('renames, groups into a summary, and puts a new element where the schema has it', () => {
    const edited = editReport(live, {
      name: 'Enrollments by Status',
      description: 'Rolling',
      format: 'Summary',
      groupingsDown: [{ field: 'Referral$Status' }],
      sort: { column: 'Referral$Name', order: 'Desc' },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const keys = Object.keys(edited.metadata);
    expect(keys).toEqual([...keys].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(edited.metadata).toMatchObject({
      name: 'Enrollments by Status',
      description: 'Rolling',
      format: 'Summary',
      sortColumn: 'Referral$Name',
      sortOrder: 'Desc',
    });
  });

  it('refuses what does not fit: a column not there, groupings on a tabular report, nothing', () => {
    const absent = editReport(live, { removeColumns: ['Referral$Nope'] });
    expect(absent.ok === false && absent.errors).toEqual([
      'Referral$Nope is not a column of the report, so it cannot be taken off.',
    ]);
    const grouped = editReport(live, { groupingsDown: [{ field: 'Referral$Status' }] });
    expect(grouped.ok === false && grouped.errors[0]).toContain(
      'A tabular report has no groupings'
    );
    const unknown = editReport(live, { addColumns: [{ field: 'X' }] }, () => null);
    expect(unknown.ok === false && unknown.errors).toEqual(['Referrals__c has no column X.']);
    expect(editReport(live, { name: 'Enrollments' })).toEqual({
      ok: false,
      errors: ['Nothing in that changes the report.'],
    });
  });
});
