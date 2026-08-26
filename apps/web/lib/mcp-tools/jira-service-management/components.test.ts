/**
 * The JSM side of components.
 *
 * The asymmetry these pin down: a service desk request can only carry a
 * field its REQUEST TYPE declares, so "the project has a Billing component"
 * and "this request can be filed under Billing" are different questions.
 * Answering the first when asked the second is how a component silently
 * fails to land — the servicedeskapi rejects the whole payload for a field
 * the form does not have, which would cost the request itself.
 */

import {
  describeComponents,
  loadProjectComponents,
  loadRequestTypeComponents,
  matchComponents,
  resolveServiceDesk,
  PROJECT_COMPONENT_READ,
} from './components';
import type { JsmAuth } from './jsm-auth';

/** A JsmAuth that serves canned bodies by URL fragment and records scopes. */
function stub(routes: Record<string, unknown>): {
  auth: JsmAuth;
  calls: { path: string; scopes: readonly string[] }[];
} {
  const calls: { path: string; scopes: readonly string[] }[] = [];
  const auth: JsmAuth = {
    kind: 'oauth',
    async fetch(scopes, path) {
      calls.push({ path, scopes });
      for (const [needle, payload] of Object.entries(routes)) {
        if (path.includes(needle)) {
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    },
  };
  return { auth, calls };
}

const FIELD_URL = '/requesttype/42/field';

describe('resolveServiceDesk', () => {
  it('turns a project key into the numeric id the write API insists on', async () => {
    const { auth } = stub({
      '/servicedeskapi/servicedesk/CAS': { id: '7', projectKey: 'CAS' },
    });
    const found = await resolveServiceDesk(auth, 'CAS');
    expect(found.ok && found.desk).toEqual({ id: '7', projectKey: 'CAS' });
  });

  it('carries the project key back, since the same response already has it', async () => {
    // The whole reason this returns a desk rather than a bare id: the
    // project listing needs the key, and paying for a second lookup to get
    // something the first response contained would be silly.
    const { auth, calls } = stub({
      '/servicedeskapi/servicedesk/7': { id: '7', projectKey: 'ENG' },
    });
    const found = await resolveServiceDesk(auth, '7');
    expect(found.ok && found.desk.projectKey).toBe('ENG');
    expect(calls).toHaveLength(1);
  });

  it('says where to look when the desk does not resolve', async () => {
    const { auth } = stub({});
    const found = await resolveServiceDesk(auth, 'NOPE');
    expect(found.ok).toBe(false);
    expect(!found.ok && found.message).toContain('jsm_list_service_desks');
  });

  it('refuses an empty id without spending a call', async () => {
    const { auth, calls } = stub({});
    const found = await resolveServiceDesk(auth, '   ');
    expect(found.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('loadRequestTypeComponents', () => {
  it('reads validValues as id and name', async () => {
    const { auth } = stub({
      [FIELD_URL]: {
        requestTypeFields: [
          { fieldId: 'summary', name: 'Summary' },
          {
            fieldId: 'components',
            name: 'Components',
            validValues: [
              { value: '10042', label: 'Billing' },
              { value: '10043', label: 'Platform' },
            ],
          },
        ],
      },
    });
    const found = await loadRequestTypeComponents(auth, '7', '42');
    expect(found.ok && found.components).toEqual({
      present: true,
      options: [
        { id: '10042', name: 'Billing' },
        { id: '10043', name: 'Platform' },
      ],
    });
  });

  it('reports a form with no components field as absent, not as an error', async () => {
    // The distinction that matters: absent means "stop trying, nothing can
    // set one here", where an error means "try again". Collapsing the two
    // sends a caller round a loop it cannot win.
    const { auth } = stub({ [FIELD_URL]: { requestTypeFields: [{ fieldId: 'summary' }] } });
    const found = await loadRequestTypeComponents(auth, '7', '42');
    expect(found.ok && found.components).toEqual({ present: false, options: [] });
  });

  it('treats a present-but-empty option set as present', async () => {
    // The form has the field; the project just has no components yet.
    const { auth } = stub({
      [FIELD_URL]: { requestTypeFields: [{ fieldId: 'components', validValues: [] }] },
    });
    const found = await loadRequestTypeComponents(auth, '7', '42');
    expect(found.ok && found.components).toEqual({ present: true, options: [] });
  });

  it('survives the paged shape, which uses a different key', async () => {
    const { auth } = stub({
      [FIELD_URL]: {
        values: [{ fieldId: 'components', validValues: [{ value: '1', label: 'A' }] }],
      },
    });
    const found = await loadRequestTypeComponents(auth, '7', '42');
    expect(found.ok && found.components.options).toEqual([{ id: '1', name: 'A' }]);
  });

  it('costs only the JSM read scope', async () => {
    // The point of preferring this path: it works on a connection that has
    // never been granted anything from the Jira project family.
    const { auth, calls } = stub({ [FIELD_URL]: { requestTypeFields: [] } });
    await loadRequestTypeComponents(auth, '7', '42');
    expect(calls[0].scopes).not.toContain(PROJECT_COMPONENT_READ);
  });
});

describe('loadProjectComponents', () => {
  it('asks the platform, under the project-component scope', async () => {
    const { auth, calls } = stub({
      '/rest/api/3/project/ENG/components': [
        { id: '10042', name: 'Billing' },
        { id: '10043', name: 'Platform' },
      ],
    });
    const found = await loadProjectComponents(auth, 'ENG');
    expect(found.ok && found.options).toHaveLength(2);
    expect(calls[0].scopes).toEqual([PROJECT_COMPONENT_READ]);
  });

  it('does not call out at all without a project key', async () => {
    const { auth, calls } = stub({});
    const found = await loadProjectComponents(auth, '');
    expect(found.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('matchComponents', () => {
  const OPTIONS = [
    { id: '10042', name: 'Billing' },
    { id: '10043', name: 'Platform' },
  ];

  it('matches on case and on whitespace either side', () => {
    const { resolved, missing } = matchComponents([' billing ', 'PLATFORM'], OPTIONS);
    expect(resolved.map((option) => option.id)).toEqual(['10042', '10043']);
    expect(missing).toEqual([]);
  });

  it('matches an id as readily as a name', () => {
    const { resolved } = matchComponents(['10043'], OPTIONS);
    expect(resolved).toEqual([{ id: '10043', name: 'Platform' }]);
  });

  it('separates the good from the bad rather than failing the lot', () => {
    // A request with two of three components is worth creating; the third
    // is worth SAYING. Refusing everything because one name was wrong is
    // the behaviour this replaces.
    const { resolved, missing } = matchComponents(['Billing', 'Billling'], OPTIONS);
    expect(resolved).toEqual([{ id: '10042', name: 'Billing' }]);
    expect(missing).toEqual(['Billling']);
  });

  it('ignores blanks instead of reporting them as missing', () => {
    const { resolved, missing } = matchComponents(['', '  ', 'Billing'], OPTIONS);
    expect(resolved).toHaveLength(1);
    expect(missing).toEqual([]);
  });

  it('finds nothing when there is nothing to find', () => {
    const { resolved, missing } = matchComponents(['Billing'], []);
    expect(resolved).toEqual([]);
    expect(missing).toEqual(['Billing']);
  });
});

describe('describeComponents', () => {
  it('names each one with its id, so a retry can use either', () => {
    expect(describeComponents([{ id: '10042', name: 'Billing' }])).toBe('Billing (10042)');
  });

  it('says so plainly when the project has none', () => {
    expect(describeComponents([])).toBe('This project has no components.');
  });
});
