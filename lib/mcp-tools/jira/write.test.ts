/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  jiraFetch: (...args: unknown[]) => jiraFetchMock(...args),
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  getCachedDisplayName: () => 'Tester',
}));

import { clearFieldSchemaCache } from './field-schema';
import { registerWriteTools } from './write';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

const STORY_POINTS = {
  id: 'customfield_10016',
  name: 'Story Points',
  custom: true,
  schema: { type: 'number' },
  clauseNames: ['cf[10016]', 'Story Points'],
};

const DECISION = {
  id: 'customfield_12013',
  name: 'Decision of Change Request',
  custom: true,
  schema: { type: 'option' },
  clauseNames: ['cf[12013]'],
};

/** Jira's 400 for a field the project will not accept, as jiraFetch surfaces it. */
class FakeJiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fieldErrors: Record<string, string>
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

interface ServeOptions {
  /** Field ids the project refuses, reported in the `errors` map. */
  refuse?: string[];
  /** Field ids refused with no errors map — named only in the message. */
  refuseInProse?: string[];
  /** Fail the comment endpoint, to prove the write still stands. */
  breakComments?: boolean;
}

let options: ServeOptions = {};

/** Serve the field endpoint from `schema`, refusing whatever `options` says to. */
function serve(schema: unknown[], serveOptions: ServeOptions = {}): void {
  calls = [];
  options = serveOptions;
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async (url: string, _token: string, request?: { method?: string; body?: string }) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : null;
      calls.push({ url, method, body });

      if (url.endsWith('/field')) {
        return { ok: true, status: 200, json: async () => schema };
      }

      if (url.endsWith('/comment')) {
        if (options.breakComments) throw new FakeJiraApiError('Jira API 403: no comment', 403, {});
        return { ok: true, status: 201, json: async () => ({ id: '1' }) };
      }

      const sent = body && typeof body.fields === 'object' ? Object.keys(body.fields) : [];

      const refusedInMap = (options.refuse ?? []).filter((field) => sent.includes(field));
      if (refusedInMap.length > 0) {
        throw new FakeJiraApiError(
          'Jira API 400: field cannot be set',
          400,
          Object.fromEntries(
            refusedInMap.map((field) => [
              field,
              `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.`,
            ])
          )
        );
      }

      const refusedInProse = (options.refuseInProse ?? []).filter((field) => sent.includes(field));
      if (refusedInProse.length > 0) {
        throw new FakeJiraApiError(
          `Jira API 400: Field '${refusedInProse[0]}' cannot be set.`,
          400,
          {}
        );
      }

      return { ok: true, status: 200, json: async () => ({ key: 'CHG-25' }) };
    }
  );
}

async function tools(): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;

  await registerWriteTools(server, {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    accessToken: 'token-1',
    maxJqlResults: 100,
  } as MCPToolContext);

  return registered;
}

const updateIssue = async (): Promise<ToolHandler> => (await tools()).get('update_issue')!;
const createIssue = async (): Promise<ToolHandler> => (await tools()).get('create_issue')!;

const putBody = () => calls.find((call) => call.method === 'PUT')?.body ?? null;
const putBodies = () => calls.filter((call) => call.method === 'PUT').map((call) => call.body);
const postBodies = (suffix: string) =>
  calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix)).map((c) => c.body);
const commentText = () => JSON.stringify(postBodies('/comment')[0] ?? {});
const putFields = () => {
  const body = putBody();
  return body && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : null;
};

beforeEach(() => {
  clearFieldSchemaCache();
});

describe('update_issue', () => {
  it('still updates the plain fields without touching the schema', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', summary: 'New title' });

    expect(result.isError).toBeUndefined();
    expect(putFields()).toEqual({ summary: 'New title' });
    // No field lookup is needed for fields whose ids are fixed.
    expect(calls.some((call) => call.url.endsWith('/field'))).toBe(false);
  });

  it('resolves story points to this site own field id', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', storyPoints: 5 });

    expect(putFields()).toEqual({ customfield_10016: 5 });
    expect(result.content[0].text).toContain('Story Points → 5');
  });

  it('records story points as a comment when the site has no such field', async () => {
    serve([DECISION]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', storyPoints: 5 });

    // Nothing was sendable, so no request was made — but the value survives.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_fields');
    expect(putBody()).toBeNull();
    expect(commentText()).toContain('Story points');
  });

  it('sets the original estimate through timetracking', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    await update({ issueKey: 'CHG-20', originalEstimate: '3d' });

    expect(putFields()).toEqual({ timetracking: { originalEstimate: '3d' } });
  });

  it('does not send an estimate Jira would not parse, and says why', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', originalEstimate: '3 days' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Jira duration');
    expect(putBody()).toBeNull();
  });

  it('applies the rest when only the estimate is malformed', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({
      issueKey: 'CHG-20',
      summary: 'still applies',
      originalEstimate: 'ages',
    });

    expect(result.isError).toBeUndefined();
    expect(putFields()).toEqual({ summary: 'still applies' });
    expect(commentText()).toContain('Original estimate');
  });

  it('resolves arbitrary fields by name and shapes them', async () => {
    serve([STORY_POINTS, DECISION]);
    const update = await updateIssue();

    const result = await update({
      issueKey: 'CHG-20',
      fields: { 'Decision of Change Request': 'Approved', '10016': 8 },
    });

    expect(putFields()).toEqual({
      customfield_12013: { value: 'Approved' },
      customfield_10016: 8,
    });
    expect(result.content[0].text).toContain('Decision of Change Request (customfield_12013)');
  });

  it('still applies what it can when a field name does not resolve', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({
      issueKey: 'CHG-20',
      summary: 'applies anyway',
      fields: { Nonexistent: 'x' },
    });

    expect(result.isError).toBeUndefined();
    expect(putFields()).toEqual({ summary: 'applies anyway' });
    expect(result.content[0].text).toContain('Not set');
    // The value survives on the issue even though the field would not take it.
    expect(commentText()).toContain('Nonexistent');
  });

  it('combines everything into one request', async () => {
    serve([STORY_POINTS, DECISION]);
    const update = await updateIssue();

    await update({
      issueKey: 'CHG-20',
      summary: 'Billing change',
      storyPoints: 3,
      originalEstimate: '1w 2d',
      fields: { 'Decision of Change Request': 'Approved' },
    });

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(putFields()).toEqual({
      summary: 'Billing change',
      customfield_10016: 3,
      timetracking: { originalEstimate: '1w 2d' },
      customfield_12013: { value: 'Approved' },
    });
  });

  it('says so rather than sending an empty update', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing to update');
    expect(putBody()).toBeNull();
  });

  it('loads the schema once across several updates', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    await update({ issueKey: 'CHG-20', storyPoints: 1 });
    await update({ issueKey: 'CHG-21', storyPoints: 2 });
    await update({ issueKey: 'CHG-22', storyPoints: 3 });

    expect(calls.filter((call) => call.url.endsWith('/field'))).toHaveLength(1);
  });

  it('requires an issue key', async () => {
    serve([STORY_POINTS]);
    const update = await updateIssue();

    const result = await update({ storyPoints: 5 });

    expect(result.isError).toBe(true);
    expect(putBody()).toBeNull();
  });
});

describe('fields a project will not accept', () => {
  it('drops the refused field and retries, keeping the rest', async () => {
    serve([STORY_POINTS], { refuse: ['customfield_10016'] });
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', summary: 'Keeps this', storyPoints: 5 });

    expect(putBodies()).toHaveLength(2);
    expect(putFields()).toEqual({ summary: 'Keeps this', customfield_10016: 5 });
    // The second attempt is the one that stands.
    expect(putBodies()[1]).toEqual({ fields: { summary: 'Keeps this' } });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Not set');
  });

  it('records what was dropped as a comment on the issue', async () => {
    serve([STORY_POINTS], { refuse: ['customfield_10016'] });
    const update = await updateIssue();

    await update({ issueKey: 'CHG-20', summary: 'x', storyPoints: 5 });

    const comment = commentText();
    expect(comment).toContain('Story Points');
    expect(comment).toContain('not on the appropriate screen');
  });

  it('reads a refusal that only appears in the message prose', async () => {
    serve([STORY_POINTS], { refuseInProse: ['customfield_10016'] });
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', summary: 'x', storyPoints: 5 });

    expect(putBodies()).toHaveLength(2);
    expect(result.isError).toBeUndefined();
  });

  it('drops a built-in field the project refuses, rather than losing the update', async () => {
    serve([STORY_POINTS], { refuse: ['priority'] });
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', summary: 'Kept', priority: 'Highest' });

    expect(putBodies()[1]).toEqual({ fields: { summary: 'Kept' } });
    expect(result.content[0].text).toContain('Priority → Highest');
    expect(commentText()).toContain('Priority → Highest');
  });

  it('gives up without a request when every field is refused', async () => {
    serve([STORY_POINTS], { refuse: ['customfield_10016'] });
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', storyPoints: 5 });

    // One attempt, then nothing left to send — not an empty PUT.
    expect(putBodies()).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing could be written');
    expect(commentText()).toContain('Story Points');
  });

  it('reports a failure that blames nothing droppable, without retrying', async () => {
    serve([STORY_POINTS], { refuse: ['issuetype'] });
    const create = await createIssue();

    const result = await create({
      projectKey: 'CHG',
      issueType: 'Nonsense',
      summary: 'x',
      storyPoints: 5,
    });

    expect(result.isError).toBe(true);
    expect(postBodies('/issue')).toHaveLength(1);
  });

  it('stands even when the comment recording the loss fails', async () => {
    serve([STORY_POINTS], { refuse: ['customfield_10016'], breakComments: true });
    const update = await updateIssue();

    const result = await update({ issueKey: 'CHG-20', summary: 'Kept', storyPoints: 5 });

    expect(result.isError).toBeUndefined();
    expect(putBodies()[1]).toEqual({ fields: { summary: 'Kept' } });
    expect(result.content[0].text).toContain('the comment recording them also failed');
  });
});

describe('create_issue', () => {
  it('sets story points, the estimate and custom fields at creation', async () => {
    serve([STORY_POINTS, DECISION]);
    const create = await createIssue();

    const result = await create({
      projectKey: 'CHG',
      issueType: 'Story',
      summary: 'Billing change',
      storyPoints: 3,
      originalEstimate: '1w 2d',
      fields: { 'Decision of Change Request': 'Approved' },
    });

    expect(postBodies('/issue')[0]).toEqual({
      fields: {
        project: { key: 'CHG' },
        issuetype: { name: 'Story' },
        summary: 'Billing change',
        customfield_10016: 3,
        timetracking: { originalEstimate: '1w 2d' },
        customfield_12013: { value: 'Approved' },
      },
    });
    expect(result.content[0].text).toContain('Created issue CHG-25');
  });

  it('creates the issue anyway when the project refuses a field on create', async () => {
    serve([STORY_POINTS], { refuse: ['customfield_10016'] });
    const create = await createIssue();

    const result = await create({
      projectKey: 'CHG',
      issueType: 'Task',
      summary: 'Still created',
      storyPoints: 5,
    });

    const attempts = postBodies('/issue');
    expect(attempts).toHaveLength(2);
    // The mandatory fields are on every attempt.
    expect(attempts[1]).toEqual({
      fields: { project: { key: 'CHG' }, issuetype: { name: 'Task' }, summary: 'Still created' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Created issue CHG-25');
    expect(commentText()).toContain('Story Points');
  });

  it('creates and comments when a field name does not resolve', async () => {
    serve([STORY_POINTS]);
    const create = await createIssue();

    const result = await create({
      projectKey: 'CHG',
      issueType: 'Task',
      summary: 'x',
      fields: { Nonexistent: 'value' },
    });

    expect(result.isError).toBeUndefined();
    expect(postBodies('/issue')).toHaveLength(1);
    expect(commentText()).toContain('Nonexistent');
  });

  it('comments on the issue it just created, by key', async () => {
    serve([STORY_POINTS], { refuse: ['customfield_10016'] });
    const create = await createIssue();

    await create({ projectKey: 'CHG', issueType: 'Task', summary: 'x', storyPoints: 5 });

    expect(calls.some((call) => call.url.includes('/issue/CHG-25/comment'))).toBe(true);
  });

  it('still requires the mandatory arguments', async () => {
    serve([STORY_POINTS]);
    const create = await createIssue();

    const result = await create({ projectKey: 'CHG', summary: 'no type' });

    expect(result.isError).toBe(true);
    expect(postBodies('/issue')).toHaveLength(0);
  });
});
