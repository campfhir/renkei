import { instanceStatus, shapeReportRun } from './reports';

/** A summary report run, in the shape the Reports API answers (trimmed). */
const summaryRun = {
  attributes: { reportId: '00O000000000001AAA', reportName: 'Open visits by stage' },
  allData: true,
  reportMetadata: {
    reportFormat: 'SUMMARY',
    aggregates: ['RowCount', 's!Attendees__c'],
    detailColumns: ['Site_Visit__c.Name', 'Site_Visit__c.Visit_Date__c'],
    reportFilters: [{ column: 'Site_Visit__c.Stage__c', operator: 'notEqual', value: 'Retired' }],
    reportBooleanFilter: null,
    standardDateFilter: { column: 'CREATED_DATE', durationValue: 'THIS_QUARTER' },
  },
  reportExtendedMetadata: {
    aggregateColumnInfo: {
      RowCount: { label: 'Record Count' },
      's!Attendees__c': { label: 'Sum of Attendees' },
    },
    detailColumnInfo: {
      'Site_Visit__c.Name': { label: 'Visit Number' },
      'Site_Visit__c.Visit_Date__c': { label: 'Visit Date' },
    },
  },
  groupingsDown: {
    groupings: [
      { key: '0', label: 'Scheduled', value: 'Scheduled', groupings: [] },
      { key: '1', label: 'Completed', value: 'Completed', groupings: [] },
    ],
  },
  groupingsAcross: { groupings: [] },
  factMap: {
    '0!T': {
      aggregates: [
        { label: '2', value: 2 },
        { label: '7', value: 7 },
      ],
      rows: [
        {
          dataCells: [
            { label: 'SV-0001', value: 'a01' },
            { label: '10/1/2026', value: '2026-10-01' },
          ],
        },
        {
          dataCells: [
            { label: 'SV-0002', value: 'a02' },
            { label: '10/2/2026', value: '2026-10-02' },
          ],
        },
      ],
    },
    '1!T': {
      aggregates: [
        { label: '1', value: 1 },
        { label: '3', value: 3 },
      ],
      rows: [],
    },
    'T!T': {
      aggregates: [
        { label: '3', value: 3 },
        { label: '10', value: 10 },
      ],
      rows: [],
    },
  },
};

describe('shapeReportRun', () => {
  it('states the scope, groupings and total in labels', () => {
    const shaped = shapeReportRun(summaryRun);
    expect(shaped).toMatchObject({
      reportId: '00O000000000001AAA',
      name: 'Open visits by stage',
      format: 'SUMMARY',
      filters: ['Site_Visit__c.Stage__c notEqual Retired'],
      dateFilter: 'CREATED_DATE: this quarter',
      aggregates: ['Record Count', 'Sum of Attendees'],
      total: { 'Record Count': '3', 'Sum of Attendees': '10' },
      groups: [
        { down: ['Scheduled'], values: { 'Record Count': '2', 'Sum of Attendees': '7' } },
        { down: ['Completed'], values: { 'Record Count': '1', 'Sum of Attendees': '3' } },
      ],
      allData: true,
      omittedRows: 0,
    });
    expect(shaped.details).toEqual([
      { 'Visit Number': 'SV-0001', 'Visit Date': '10/1/2026' },
      { 'Visit Number': 'SV-0002', 'Visit Date': '10/2/2026' },
    ]);
  });

  it('reports truncation and caps rows', () => {
    const shaped = shapeReportRun({ ...summaryRun, allData: false }, { maxRows: 1 });
    expect(shaped.allData).toBe(false);
    expect(shaped.groups).toHaveLength(1);
    expect(shaped.omittedRows).toBe(2); // one group, one detail row
  });

  it('reads matrix cells by row and column grouping', () => {
    const shaped = shapeReportRun({
      reportMetadata: { reportFormat: 'MATRIX', aggregates: ['RowCount'] },
      groupingsDown: { groupings: [{ key: '0', label: 'West', groupings: [] }] },
      groupingsAcross: { groupings: [{ key: '0', label: 'Q3', groupings: [] }] },
      factMap: {
        '0!0': { aggregates: [{ label: '5' }] },
        'T!0': { aggregates: [{ label: '5' }] },
        'T!T': { aggregates: [{ label: '5' }] },
      },
    });
    expect(shaped.groups).toEqual([
      { down: ['Total'], across: ['Q3'], values: { 'Record Count': '5' } },
      { down: ['West'], across: ['Q3'], values: { 'Record Count': '5' } },
    ]);
  });

  it('describes a custom date range', () => {
    expect(
      shapeReportRun({
        reportMetadata: {
          standardDateFilter: {
            column: 'CLOSE_DATE',
            durationValue: 'CUSTOM',
            startDate: '2026-07-01',
            endDate: '2026-09-30',
          },
        },
      }).dateFilter
    ).toBe('CLOSE_DATE: 2026-07-01 to 2026-09-30');
  });

  it('reads an async instance status', () => {
    expect(instanceStatus({ attributes: { status: 'Running' } })).toBe('Running');
  });
});
