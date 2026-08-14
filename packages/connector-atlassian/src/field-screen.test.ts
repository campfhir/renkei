/**
 * The per-project, per-issue-type field screen.
 *
 * The property that makes this affordable is the cache: editmeta is
 * documented per issue, and calling it per issue is impossible across tens of
 * thousands. The tests pin that one lookup serves a whole combination, and
 * that a failure degrades to "keep everything" rather than to silence.
 */

jest.mock('./client', () => ({
  ...jest.requireActual('./client'),
  atlassianFetch: jest.fn(),
}));

import { atlassianFetch } from './client';
import {
  fieldScreenFor,
  createScreenFor,
  fieldByReference,
  clearFieldScreenCache,
} from './field-screen';

const mockFetch = jest.mocked(atlassianFetch);

const editmeta = (fields: Record<string, unknown>) => ({
  ok: true as const,
  status: 200,
  body: { fields },
});

const params = {
  cloudId: 'cloud-1',
  accessToken: 'token',
  issueKey: 'SYS-1',
  projectKey: 'SYS',
  issueTypeId: '10018',
};

beforeEach(() => {
  clearFieldScreenCache();
  mockFetch.mockReset();
});

describe('fieldScreenFor', () => {
  it('reads the editable fields for a project and issue type', async () => {
    mockFetch.mockResolvedValue(
      editmeta({
        customfield_10029: {
          name: 'Request participants',
          schema: { type: 'array' },
          operations: ['add'],
        },
        priority: { name: 'Priority', required: false, schema: { type: 'priority' } },
      })
    );

    const screen = await fieldScreenFor(params);
    expect(screen?.fields.get('customfield_10029')?.name).toBe('Request participants');
    expect([...(screen?.customFieldIds ?? [])]).toEqual(['customfield_10029']);
    // System fields are present too, for callers resolving an edit.
    expect(screen?.fields.get('priority')?.schemaType).toBe('priority');
  });

  it('serves a whole combination from one call', async () => {
    // The reason this is affordable at all: editmeta is per issue, and one
    // call per issue is impossible across tens of thousands.
    mockFetch.mockResolvedValue(editmeta({ priority: { name: 'Priority' } }));

    await fieldScreenFor(params);
    await fieldScreenFor({ ...params, issueKey: 'SYS-2' });
    await fieldScreenFor({ ...params, issueKey: 'SYS-3' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate answer per issue type', async () => {
    mockFetch.mockResolvedValue(editmeta({ priority: { name: 'Priority' } }));
    await fieldScreenFor(params);
    await fieldScreenFor({ ...params, issueTypeId: '10019' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent lookups into one request', async () => {
    mockFetch.mockResolvedValue(editmeta({ priority: { name: 'Priority' } }));
    await Promise.all([fieldScreenFor(params), fieldScreenFor(params), fieldScreenFor(params)]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the screen cannot be read', async () => {
    // Callers read null as "keep everything" — dropping fields because a
    // metadata call failed is the wrong way to be wrong.
    mockFetch.mockResolvedValue({ ok: false as const, status: 403, error: 'forbidden' });
    expect(await fieldScreenFor(params)).toBeNull();
  });

  it('does not retry a known failure for every issue', async () => {
    mockFetch.mockResolvedValue({ ok: false as const, status: 403, error: 'forbidden' });
    await fieldScreenFor(params);
    await fieldScreenFor({ ...params, issueKey: 'SYS-2' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to guess without a project and issue type', async () => {
    expect(await fieldScreenFor({ ...params, projectKey: '' })).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('flattens select options to the labels a person would type', async () => {
    mockFetch.mockResolvedValue(
      editmeta({
        customfield_10006: {
          name: 'Change risk',
          schema: { type: 'option' },
          allowedValues: [
            { value: 'Medium', id: '1' },
            { value: 'High', id: '2' },
          ],
        },
      })
    );
    const screen = await fieldScreenFor(params);
    expect(screen?.fields.get('customfield_10006')?.allowedValues).toEqual(['Medium', 'High']);
  });
});

describe('fieldByReference', () => {
  it('resolves by id and by the name a person used', async () => {
    mockFetch.mockResolvedValue(editmeta({ customfield_10029: { name: 'Request participants' } }));
    const screen = await fieldScreenFor(params);
    expect(fieldByReference(screen!, 'customfield_10029')?.name).toBe('Request participants');
    expect(fieldByReference(screen!, 'request participants')?.id).toBe('customfield_10029');
    expect(fieldByReference(screen!, 'nonsense')).toBeNull();
  });
});

describe('createScreenFor', () => {
  const createParams = {
    cloudId: 'cloud-1',
    accessToken: 'token',
    projectKey: 'SYS',
    issueTypeId: '10018',
  };

  const createmeta = (fields: unknown[]) => ({
    ok: true as const,
    status: 200,
    body: { fields },
  });

  it('parses the create screen', async () => {
    mockFetch.mockResolvedValue(
      createmeta([
        { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
        { fieldId: 'customfield_10005', name: 'Change type', schema: { type: 'option' } },
      ])
    );
    const screen = await createScreenFor(createParams);
    expect(screen?.fields.get('summary')?.required).toBe(true);
    expect([...(screen?.customFieldIds ?? [])]).toEqual(['customfield_10005']);
  });

  it('needs no sample issue, because there is no issue yet', async () => {
    mockFetch.mockResolvedValue(createmeta([{ fieldId: 'summary', name: 'Summary' }]));
    expect(await createScreenFor(createParams)).not.toBeNull();
  });

  it('does not share a cache entry with the edit screen', async () => {
    // They genuinely differ, and collapsing them would validate a create
    // payload against the edit form.
    mockFetch.mockResolvedValueOnce(
      editmeta({ customfield_10029: { name: 'Request participants' } })
    );
    mockFetch.mockResolvedValueOnce(createmeta([{ fieldId: 'summary', name: 'Summary' }]));

    const edit = await fieldScreenFor(params);
    const create = await createScreenFor(createParams);

    expect(edit?.fields.has('customfield_10029')).toBe(true);
    expect(create?.fields.has('customfield_10029')).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null when the create screen cannot be read', async () => {
    mockFetch.mockResolvedValue({ ok: false as const, status: 404, error: 'no such project' });
    expect(await createScreenFor(createParams)).toBeNull();
  });
});
