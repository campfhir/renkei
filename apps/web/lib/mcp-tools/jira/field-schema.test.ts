/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  jiraFetch: (...args: unknown[]) => jiraFetchMock(...args),
}));

import {
  buildFieldUpdates,
  clearFieldSchemaCache,
  coerceFieldValue,
  findStoryPointsField,
  isJiraDuration,
  isRichTextField,
  loadFieldSchema,
  lookupField,
  type JiraField,
} from './field-schema';
import { adfToMarkdown } from './adf';

const field = (over: Partial<JiraField> & Pick<JiraField, 'id' | 'name'>): JiraField => ({
  custom: over.id.startsWith('customfield_'),
  type: 'string',
  clauseNames: [over.name.toLowerCase()],
  ...over,
});

const SCHEMA: JiraField[] = [
  field({ id: 'summary', name: 'Summary' }),
  field({
    id: 'customfield_10016',
    name: 'Story Points',
    type: 'number',
    clauseNames: ['cf[10016]', 'Story Points'],
  }),
  field({ id: 'customfield_12013', name: 'Decision of Change Request', type: 'option' }),
  field({ id: 'customfield_12014', name: 'Reviewers', type: 'array', itemType: 'user' }),
  field({ id: 'customfield_12015', name: 'Impacted Systems', type: 'array', itemType: 'option' }),
  field({ id: 'customfield_12016', name: 'Go Live Date', type: 'date' }),
  field({ id: 'customfield_12017', name: 'Change Owner', type: 'user' }),
  field({ id: 'timetracking', name: 'Time tracking', type: 'timetracking' }),
];

/** Serve `payload` as the field endpoint, recording how often it is called. */
function serveSchema(payload: unknown): void {
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
}

const context = {
  tenantId: 'tenant-1',
  accountId: 'acct-1',
  siteUrl: 'https://example.atlassian.net',
  apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
  accessToken: 'token-1',
  maxJqlResults: 100,
} as MCPToolContext;

const RAW = [
  {
    id: 'summary',
    name: 'Summary',
    custom: false,
    schema: { type: 'string' },
    clauseNames: ['summary'],
  },
  {
    id: 'customfield_10016',
    name: 'Story Points',
    custom: true,
    schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
    clauseNames: ['cf[10016]', 'Story Points'],
  },
  { id: 'malformed-without-name', custom: true },
];

beforeEach(() => {
  clearFieldSchemaCache();
});

describe('lookupField', () => {
  it('finds a field by its id', () => {
    const found = lookupField(SCHEMA, 'customfield_10016');
    expect(found.ok && found.field.name).toBe('Story Points');
  });

  it('accepts a bare number and the JQL spelling', () => {
    expect(lookupField(SCHEMA, '10016').ok).toBe(true);
    expect(lookupField(SCHEMA, 'cf[10016]').ok).toBe(true);
  });

  it('finds a field by display name, case-insensitively', () => {
    const found = lookupField(SCHEMA, 'decision of change request');
    expect(found.ok && found.field.id).toBe('customfield_12013');
  });

  it('accepts a unique partial name', () => {
    const found = lookupField(SCHEMA, 'Go Live');
    expect(found.ok && found.field.id).toBe('customfield_12016');
  });

  it('refuses an ambiguous partial rather than guessing', () => {
    const withDuplicate = [
      ...SCHEMA,
      field({ id: 'customfield_99999', name: 'Story Points (old)' }),
    ];
    const found = lookupField(withDuplicate, 'story points');

    // The exact name still wins over the partial.
    expect(found.ok && found.field.id).toBe('customfield_10016');

    const vague = lookupField(withDuplicate, 'points');
    expect(vague.ok).toBe(false);
    expect(!vague.ok && vague.reason).toBe('ambiguous');
    expect(!vague.ok && vague.message).toContain('customfield_99999');
  });

  it('says what to do when nothing matches', () => {
    const missing = lookupField(SCHEMA, 'Nonexistent');
    expect(!missing.ok && missing.reason).toBe('unknown');
    expect(!missing.ok && missing.message).toContain('jira_list_fields');
  });
});

describe('coerceFieldValue', () => {
  const of = (name: string) => {
    const found = lookupField(SCHEMA, name);
    if (!found.ok) throw new Error(`test schema has no ${name}`);
    return found.field;
  };

  /** Coerce, asserting success, for the cases that are only about the shape. */
  const shaped = (name: string, value: unknown): unknown => {
    const result = coerceFieldValue(of(name), value);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };

  it('passes a number through, and parses a numeric string', () => {
    expect(coerceFieldValue(of('Story Points'), 5)).toEqual({ ok: true, value: 5 });
    expect(coerceFieldValue(of('Story Points'), '3.5')).toEqual({ ok: true, value: 3.5 });
  });

  it('refuses a number field given words', () => {
    const result = coerceFieldValue(of('Story Points'), 'a lot');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('takes a number');
  });

  it('wraps a select value in the option shape', () => {
    expect(coerceFieldValue(of('Decision of Change Request'), 'Approved')).toEqual({
      ok: true,
      value: { value: 'Approved' },
    });
  });

  it('leaves an already-shaped object alone', () => {
    expect(coerceFieldValue(of('Decision of Change Request'), { id: '10201' })).toEqual({
      ok: true,
      value: { id: '10201' },
    });
  });

  it('builds option arrays, from an array or a comma-separated string', () => {
    expect(shaped('Impacted Systems', ['Billing', 'Auth'])).toEqual([
      { value: 'Billing' },
      { value: 'Auth' },
    ]);
    expect(shaped('Impacted Systems', 'Billing, Auth')).toEqual([
      { value: 'Billing' },
      { value: 'Auth' },
    ]);
  });

  it('builds user arrays by account id', () => {
    expect(shaped('Reviewers', ['abc', 'def'])).toEqual([
      { accountId: 'abc' },
      { accountId: 'def' },
    ]);
  });

  it('asks for an account id rather than sending an email Jira ignores', () => {
    const result = coerceFieldValue(of('Change Owner'), 'dana@x.test');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('jira_search_users');
  });

  it('checks the shape of a date', () => {
    expect(coerceFieldValue(of('Go Live Date'), '2026-09-01')).toEqual({
      ok: true,
      value: '2026-09-01',
    });
    const wrong = coerceFieldValue(of('Go Live Date'), 'next Tuesday');
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.message).toContain('YYYY-MM-DD');
  });

  it('treats a bare string on timetracking as the original estimate', () => {
    expect(coerceFieldValue(of('Time tracking'), '3d')).toEqual({
      ok: true,
      value: { originalEstimate: '3d' },
    });
  });

  it('allows clearing a field with null', () => {
    expect(coerceFieldValue(of('Story Points'), null)).toEqual({ ok: true, value: null });
  });

  it('passes an unmodelled type through for Jira to validate', () => {
    const odd = field({ id: 'customfield_40000', name: 'Odd', type: 'sd-approvals' });
    expect(coerceFieldValue(odd, { anything: true })).toEqual({
      ok: true,
      value: { anything: true },
    });
  });

  it('emits the option id when the option set carries one', () => {
    const decision = field({
      id: 'customfield_12013',
      name: 'Decision of Change Request',
      type: 'option',
      allowedValues: [{ value: 'Approved', id: '10201' }],
    });
    expect(coerceFieldValue(decision, 'approved')).toEqual({ ok: true, value: { id: '10201' } });
  });

  it('lists the valid options when a select value matches none', () => {
    const decision = field({
      id: 'customfield_12013',
      name: 'Decision of Change Request',
      type: 'option',
      allowedValues: [
        { value: 'Approved', id: '10201' },
        { value: 'Rejected', id: '10202' },
      ],
    });
    const result = coerceFieldValue(decision, 'Maybe');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('"Approved" (id 10201)');
    expect(!result.ok && result.message).toContain('"Rejected" (id 10202)');
  });
});

describe('request type (sd-customerrequesttype)', () => {
  const requestType = (allowedValues?: { value: string; id?: string }[]) =>
    field({
      id: 'customfield_10010',
      name: 'Request Type',
      type: 'sd-customerrequesttype',
      customType: 'com.atlassian.servicedesk:vp-origin',
      allowedValues,
    });

  it('resolves a display name to the bare request-type id', () => {
    const rt = requestType([{ value: 'General Request or Inquiry', id: '1111' }]);
    expect(coerceFieldValue(rt, 'general request or inquiry')).toEqual({
      ok: true,
      value: '1111',
    });
  });

  it('accepts a raw id, matched against the option set', () => {
    const rt = requestType([{ value: 'General Request or Inquiry', id: '1111' }]);
    expect(coerceFieldValue(rt, '1111')).toEqual({ ok: true, value: '1111' });
    expect(coerceFieldValue(rt, 1111)).toEqual({ ok: true, value: '1111' });
  });

  it('lists the request types when the name matches none', () => {
    const rt = requestType([
      { value: 'General Request or Inquiry', id: '1111' },
      { value: 'Access Request', id: '1112' },
    ]);
    const result = coerceFieldValue(rt, 'Password Reset');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('"General Request or Inquiry" (id 1111)');
    expect(!result.ok && result.message).toContain('"Access Request" (id 1112)');
  });

  it('passes the raw value through when no option set is known', () => {
    expect(coerceFieldValue(requestType(), '1111')).toEqual({ ok: true, value: '1111' });
  });
});

describe('findStoryPointsField', () => {
  it('finds the company-managed name', () => {
    const found = findStoryPointsField(SCHEMA);
    expect(found.ok && found.field.id).toBe('customfield_10016');
  });

  it('finds the team-managed name', () => {
    const teamManaged = [
      field({ id: 'customfield_10032', name: 'Story point estimate', type: 'number' }),
    ];
    const found = findStoryPointsField(teamManaged);
    expect(found.ok && found.field.id).toBe('customfield_10032');
  });

  it('prefers the exact name when a site has both', () => {
    const both = [
      field({ id: 'customfield_10032', name: 'Story point estimate', type: 'number' }),
      field({ id: 'customfield_10016', name: 'Story Points', type: 'number' }),
    ];
    const found = findStoryPointsField(both);
    expect(found.ok && found.field.id).toBe('customfield_10016');
  });

  it('reports a site that has no such field', () => {
    const found = findStoryPointsField([field({ id: 'summary', name: 'Summary' })]);
    expect(found.ok).toBe(false);
    expect(!found.ok && found.message).toContain('jira_list_fields');
  });
});

describe('isJiraDuration', () => {
  it('accepts the forms Jira accepts', () => {
    expect(isJiraDuration('3d')).toBe(true);
    expect(isJiraDuration('4h')).toBe(true);
    expect(isJiraDuration('1w 2d')).toBe(true);
    expect(isJiraDuration('30m')).toBe(true);
  });

  it('rejects prose and bare numbers', () => {
    expect(isJiraDuration('3 days')).toBe(false);
    expect(isJiraDuration('3')).toBe(false);
    expect(isJiraDuration('soon')).toBe(false);
  });
});

describe('loadFieldSchema', () => {
  it('parses the endpoint and skips entries without an id and name', async () => {
    serveSchema(RAW);
    const fields = await loadFieldSchema(context);

    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.id)).toEqual(['summary', 'customfield_10016']);
    expect(fields[1]).toMatchObject({ name: 'Story Points', type: 'number', custom: true });
  });

  it('serves later calls from the cache', async () => {
    serveSchema(RAW);
    await loadFieldSchema(context);
    await loadFieldSchema(context);
    await loadFieldSchema(context);

    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes one request for concurrent callers', async () => {
    serveSchema(RAW);
    await Promise.all([
      loadFieldSchema(context),
      loadFieldSchema(context),
      loadFieldSchema(context),
    ]);

    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches when asked', async () => {
    serveSchema(RAW);
    await loadFieldSchema(context);
    await loadFieldSchema(context, { refresh: true });

    expect(jiraFetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches per site, not globally', async () => {
    serveSchema(RAW);
    await loadFieldSchema(context);
    await loadFieldSchema({ ...context, apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-2' });

    expect(jiraFetchMock).toHaveBeenCalledTimes(2);
  });

  it('survives an endpoint that does not return a list', async () => {
    serveSchema({ errorMessages: ['nope'] });
    await expect(loadFieldSchema(context)).resolves.toEqual([]);
  });
});

describe('buildFieldUpdates', () => {
  it('resolves names to ids and shapes the values', async () => {
    serveSchema(RAW);
    const updates = await buildFieldUpdates(context, { 'Story Points': 5, Summary: 'New title' });

    expect(updates.fields).toEqual({ customfield_10016: 5, summary: 'New title' });
    expect(updates.problems).toEqual([]);
    expect(updates.applied).toContain('Story Points (customfield_10016)');
  });

  it('makes no request when there is nothing to resolve', async () => {
    serveSchema(RAW);
    const updates = await buildFieldUpdates(context, {});

    expect(updates).toEqual({ fields: {}, applied: [], problems: [], optionHints: {} });
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  it('reports the fields it could not resolve, and omits them', async () => {
    serveSchema(RAW);
    const updates = await buildFieldUpdates(context, { 'Story Points': 5, Nonexistent: 'x' });

    expect(updates.fields).toEqual({ customfield_10016: 5 });
    expect(updates.problems).toHaveLength(1);
    expect(updates.problems[0]).toContain('Nonexistent');
  });

  it('refetches once for an unknown name, in case the field is new', async () => {
    serveSchema(RAW);
    await loadFieldSchema(context);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000);

    const updates = await buildFieldUpdates(context, { 'Brand New Field': 'x' });

    // Once for the initial load, once because the name was unknown.
    expect(jiraFetchMock).toHaveBeenCalledTimes(2);
    expect(updates.problems).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('does not refetch for an unknown name against a schema just loaded', async () => {
    serveSchema(RAW);
    await loadFieldSchema(context);
    await buildFieldUpdates(context, { 'Brand New Field': 'x' });

    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('buildFieldUpdates option enrichment', () => {
  const RAW_WITH_REQUEST_TYPE = [
    ...RAW,
    {
      id: 'customfield_10010',
      name: 'Request Type',
      custom: true,
      schema: {
        type: 'sd-customerrequesttype',
        custom: 'com.atlassian.servicedesk:vp-origin',
      },
      clauseNames: ['Request Type'],
    },
  ];

  /** Route the mock by endpoint, so one test can serve schema + meta + JSM. */
  function serveByUrl(routes: Record<string, unknown>): void {
    jiraFetchMock.mockReset();
    jiraFetchMock.mockImplementation(async (url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => {
        for (const [needle, payload] of Object.entries(routes)) {
          if (String(url).includes(needle)) return payload;
        }
        throw new Error(`unrouted URL in test: ${String(url)}`);
      },
    }));
  }

  it('resolves a request type display name to its id via editmeta', async () => {
    serveByUrl({
      '/editmeta': {
        fields: {
          customfield_10010: {
            allowedValues: [
              { id: '1111', name: 'General Request or Inquiry' },
              { id: '1112', name: 'Access Request' },
            ],
          },
        },
      },
      '/rest/api/3/field': RAW_WITH_REQUEST_TYPE,
    });

    const updates = await buildFieldUpdates(
      context,
      { 'Request Type': 'General Request or Inquiry' },
      { issueKey: 'ENG-707' }
    );

    expect(updates.fields).toEqual({ customfield_10010: '1111' });
    expect(updates.problems).toEqual([]);
    expect(updates.optionHints.customfield_10010).toContain('General Request or Inquiry');
  });

  it('falls back to the service-desk listing when meta carries no request types', async () => {
    serveByUrl({
      '/editmeta': { fields: {} },
      '/rest/servicedeskapi/requesttype': {
        values: [{ id: '1111', name: 'General Request or Inquiry' }],
      },
      '/rest/api/3/field': RAW_WITH_REQUEST_TYPE,
    });

    const updates = await buildFieldUpdates(
      context,
      { 'Request Type': 'General Request or Inquiry' },
      { issueKey: 'ENG-707' }
    );

    expect(updates.fields).toEqual({ customfield_10010: '1111' });
  });

  it('reports the valid options when the value matches none', async () => {
    serveByUrl({
      '/editmeta': {
        fields: {
          customfield_10010: {
            allowedValues: [{ id: '1111', name: 'General Request or Inquiry' }],
          },
        },
      },
      '/rest/api/3/field': RAW_WITH_REQUEST_TYPE,
    });

    const updates = await buildFieldUpdates(
      context,
      { 'Request Type': 'Password Reset' },
      { issueKey: 'ENG-707' }
    );

    expect(updates.fields).toEqual({});
    expect(updates.problems).toHaveLength(1);
    expect(updates.problems[0]).toContain('"General Request or Inquiry" (id 1111)');
  });

  it('filters createmeta by issue type name, not the ids the API wants', async () => {
    serveByUrl({
      '/rest/api/3/issue/createmeta': {
        projects: [
          {
            issuetypes: [
              {
                id: '10001',
                name: 'Task',
                fields: {
                  customfield_10010: {
                    allowedValues: [{ id: '1111', name: 'General Request or Inquiry' }],
                  },
                },
              },
              {
                id: '10002',
                name: 'Bug',
                fields: {
                  customfield_10010: {
                    allowedValues: [{ id: '9999', name: 'Bug Report' }],
                  },
                },
              },
            ],
          },
        ],
      },
      '/rest/api/3/field': RAW_WITH_REQUEST_TYPE,
    });

    const updates = await buildFieldUpdates(
      context,
      { 'Request Type': 'General Request or Inquiry' },
      { projectKey: 'ENG', issueType: 'Task' }
    );

    expect(updates.fields).toEqual({ customfield_10010: '1111' });
    const createmetaCall = jiraFetchMock.mock.calls.find((call) =>
      String(call[0]).includes('createmeta')
    );
    // The name must not be sent as an issueTypeIds filter — that silently
    // matched nothing, which is the bug this test pins down.
    expect(String(createmetaCall?.[0])).not.toContain('issueTypeIds');
  });
});

describe('rich text fields', () => {
  // What Jira reports for a multi-line text custom field: type "string", and a
  // write API that then refuses a string.
  const backoutPlan = field({
    id: 'customfield_10085',
    name: 'Backout Plan',
    type: 'string',
    customType: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea',
  });
  const summary = field({ id: 'summary', name: 'Summary', type: 'string' });
  const docField = field({ id: 'description', name: 'Description', type: 'doc' });

  it('recognises a textarea despite its type saying string', () => {
    expect(isRichTextField(backoutPlan)).toBe(true);
    expect(isRichTextField(docField)).toBe(true);
    expect(isRichTextField(summary)).toBe(false);
  });

  it('sends an Atlassian Document, not a string', () => {
    const result = coerceFieldValue(backoutPlan, 'Restore the snapshot, then re-run migrations.');

    expect(result.ok).toBe(true);
    const value = result.ok ? result.value : null;
    expect(value).toMatchObject({ type: 'doc', version: 1 });
    expect(adfToMarkdown(value)).toBe('Restore the snapshot, then re-run migrations.');
  });

  it('reads the string as markdown, so structure survives', () => {
    const result = coerceFieldValue(backoutPlan, '## Steps\n\n- stop writes\n- restore');
    expect(adfToMarkdown(result.ok ? result.value : null)).toBe(
      '## Steps\n\n- stop writes\n- restore'
    );
  });

  it('passes an existing document through untouched', () => {
    const doc = { type: 'doc', version: 1, content: [] };
    expect(coerceFieldValue(backoutPlan, doc)).toEqual({ ok: true, value: doc });
  });

  it('rebuilds a bare ADF fragment into a whole document', () => {
    // A node copied out of another issue's field, which is how this arose.
    const fragment = { type: 'paragraph', content: [{ type: 'text', text: 'Copied text' }] };
    const result = coerceFieldValue(backoutPlan, fragment);

    expect(result.ok && result.value).toMatchObject({ type: 'doc' });
    expect(adfToMarkdown(result.ok ? result.value : null)).toBe('Copied text');
  });

  it('never produces [object Object]', () => {
    // The reported bug: an object reached String(), the field was written with
    // the literal text "[object Object]", and Jira refused it.
    for (const value of [
      { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      { value: 'Approved' },
      { unrecognised: true },
      ['a', 'b'],
    ]) {
      const rich = coerceFieldValue(backoutPlan, value);
      const plain = coerceFieldValue(summary, value);
      expect(JSON.stringify(rich.ok ? rich.value : '')).not.toContain('[object Object]');
      expect(JSON.stringify(plain.ok ? plain.value : '')).not.toContain('[object Object]');
    }
  });

  it('keeps a plain string field a string', () => {
    expect(coerceFieldValue(summary, 'Just text')).toEqual({ ok: true, value: 'Just text' });
  });

  it('renders an object into a string field rather than mangling it', () => {
    const result = coerceFieldValue(summary, { value: 'Approved' });
    expect(result).toEqual({ ok: true, value: 'Approved' });
  });

  it('still clears with null', () => {
    expect(coerceFieldValue(backoutPlan, null)).toEqual({ ok: true, value: null });
  });
});
