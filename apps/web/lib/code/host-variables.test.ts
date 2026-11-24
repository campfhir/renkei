/**
 * The Variables tab's reads and saves against a stand-in for each host:
 * a few lines of GitHub's and Bitbucket's variable endpoints kept in
 * memory, so a test says what the host ends up holding rather than which
 * calls were made. GitHub's stand-in opens each secret with the private
 * half of the key it gave out, as GitHub does: what it holds is what was
 * sealed.
 *
 * What earns a pin: a secret never comes back by value on either host; a
 * GitHub secret travels sealed (never as text) and replaces a plain
 * variable of the same name, and the other way round; a secret's value is
 * needed to make it one or to make it plain again; saving to an
 * environment the host lacks makes it; one refusal does not stop the rest.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import nacl from 'tweetnacl';
import { asRecord } from '@renkei/guards';
import type { BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import type { GitHubAuth } from '@/lib/mcp-tools/github/github-auth';
import {
  applyBitbucketVariables,
  applyGithubVariables,
  readBitbucketVariables,
  readGithubVariables,
  readVariableChanges,
} from './host-variables';
import { openSealed } from './sealed-box';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const empty = (status = 204) => new Response(null, { status });
const missing = () => json({ message: 'Not Found' }, 404);

// ——— GitHub, stood in for ———

interface GithubSet {
  variables: Map<string, string>;
  /** Secrets by name, opened: the value GitHub would hold. */
  secrets: Map<string, string>;
}

function github(options: { refuse?: string } = {}) {
  const keys = nacl.box.keyPair();
  const sets = new Map<string, GithubSet>([['', { variables: new Map(), secrets: new Map() }]]);
  /** Every body sent, as text: nothing in it may be a secret's value. */
  const sent: string[] = [];
  const auth: GitHubAuth = {
    kind: 'oauth',
    async fetch(_scopes, pathAndQuery, init) {
      const method = init?.method ?? 'GET';
      const path = pathAndQuery.split('?')[0]!;
      if (init?.json !== undefined) sent.push(JSON.stringify(init.json));
      const one = /^\/repos\/acme\/app\/environments\/([^/]+)$/.exec(path);
      if (one) {
        const name = decodeURIComponent(one[1]!);
        if (method === 'PUT') {
          if (!sets.has(name)) sets.set(name, { variables: new Map(), secrets: new Map() });
          return json({ name });
        }
        return sets.has(name) ? json({ name }) : missing();
      }
      const scoped =
        /^\/repos\/acme\/app\/(?:actions|environments\/([^/]+))\/(variables|secrets)(?:\/([^/]+))?$/.exec(
          path
        );
      if (!scoped) return missing();
      const set = sets.get(scoped[1] ? decodeURIComponent(scoped[1]) : '');
      if (!set) return missing();
      const name = scoped[3] ? decodeURIComponent(scoped[3]) : null;
      if (options.refuse && name === options.refuse && method !== 'GET') {
        return json({ message: 'Resource not accessible by integration' }, 403);
      }
      if (scoped[2] === 'variables') {
        if (!name && method === 'GET') {
          return json({
            variables: [...set.variables].map(([key, value]) => ({ name: key, value })),
          });
        }
        const body = asRecord(init?.json);
        if (!name && method === 'POST') {
          set.variables.set(text(body.name), text(body.value));
          return json({}, 201);
        }
        if (name && method === 'PATCH') {
          set.variables.set(name, text(body.value));
          return empty();
        }
        if (name && method === 'DELETE') return set.variables.delete(name) ? empty() : missing();
        return missing();
      }
      if (!name) {
        return json({ secrets: [...set.secrets.keys()].map((key) => ({ name: key })) });
      }
      if (name === 'public-key') {
        return json({ key_id: 'k1', key: Buffer.from(keys.publicKey).toString('base64') });
      }
      if (method === 'PUT') {
        const body = asRecord(init?.json);
        const opened = openSealed(text(body.encrypted_value), keys);
        if (body.key_id !== 'k1' || opened === null) return json({ message: 'Bad seal' }, 422);
        set.secrets.set(name, opened);
        return empty(201);
      }
      if (method === 'DELETE') return set.secrets.delete(name) ? empty() : missing();
      return missing();
    },
  };
  return { auth, sets, sent, repository: sets.get('')! };
}

describe('GitHub Actions variables and secrets', () => {
  it('lists plain variables with their values and secrets by name only', async () => {
    const host = github();
    host.repository.variables.set('REGION', 'eu-west-1');
    host.repository.secrets.set('DEPLOY_TOKEN', 'never shown');
    const page = await readGithubVariables(host.auth, 'acme/app', null);
    expect(page.repository).toEqual({
      variables: [
        { key: 'DEPLOY_TOKEN', value: null, secured: true },
        { key: 'REGION', value: 'eu-west-1', secured: false },
      ],
      error: null,
    });
    expect(page.environment).toBeNull();
    expect(JSON.stringify(page)).not.toContain('never shown');
  });

  it('says whether the environment asked about exists, and reads its set when it does', async () => {
    const host = github();
    expect((await readGithubVariables(host.auth, 'acme/app', 'dev')).environment).toEqual({
      name: 'dev',
      exists: false,
      variables: [],
      error: null,
    });
    host.sets.set('dev', { variables: new Map([['API', 'x']]), secrets: new Map() });
    expect((await readGithubVariables(host.auth, 'acme/app', 'dev')).environment).toEqual({
      name: 'dev',
      exists: true,
      variables: [{ key: 'API', value: 'x', secured: false }],
      error: null,
    });
  });

  it('saves a locked row as a secret, sealed: the value never travels as text', async () => {
    const host = github();
    const saved = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [
        { key: 'API_BASE_URL', value: 'https://api.example.test', secured: false },
        { key: 'DEPLOY_TOKEN', value: 'tok-s3cr3t', secured: true },
      ],
      remove: [],
    });
    expect(saved).toEqual({
      ok: true,
      created: false,
      applied: { added: ['API_BASE_URL', 'DEPLOY_TOKEN'], changed: [], removed: [], errors: [] },
    });
    // GitHub opened it with its own key: what was sealed is what was typed.
    expect(host.repository.secrets.get('DEPLOY_TOKEN')).toBe('tok-s3cr3t');
    expect(host.repository.variables.get('API_BASE_URL')).toBe('https://api.example.test');
    expect(host.repository.variables.has('DEPLOY_TOKEN')).toBe(false);
    expect(host.sent.join('\n')).not.toContain('tok-s3cr3t');
  });

  it('locking a plain variable makes it a secret and takes the plain one away', async () => {
    const host = github();
    host.repository.variables.set('REGION', 'eu-west-1');
    const saved = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [{ key: 'REGION', value: 'eu-west-1', secured: true }],
      remove: [],
    });
    expect(saved.ok && saved.applied.changed).toEqual(['REGION']);
    expect(host.repository.variables.has('REGION')).toBe(false);
    expect(host.repository.secrets.get('REGION')).toBe('eu-west-1');
  });

  it('unlocking a secret needs its value again, and then takes the secret away', async () => {
    const host = github();
    host.repository.secrets.set('REGION', 'eu-west-1');
    const blank = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [{ key: 'REGION', value: '', secured: false }],
      remove: [],
    });
    expect(blank.ok && blank.applied.errors).toEqual([
      'REGION: its value is secret and cannot be read back; type it again to make it plain.',
    ]);
    expect(host.repository.secrets.has('REGION')).toBe(true);
    const typed = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [{ key: 'REGION', value: 'us-east-1', secured: false }],
      remove: [],
    });
    expect(typed.ok && typed.applied.changed).toEqual(['REGION']);
    expect(host.repository.secrets.has('REGION')).toBe(false);
    expect(host.repository.variables.get('REGION')).toBe('us-east-1');
  });

  it('changes only what differs, and removes a name from wherever it is', async () => {
    const host = github();
    host.repository.variables.set('SAME', '1');
    host.repository.variables.set('OLD', 'x');
    host.repository.secrets.set('OLD_SECRET', 'y');
    const saved = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [{ key: 'SAME', value: '1', secured: false }],
      remove: ['OLD', 'OLD_SECRET', 'NEVER_THERE'],
    });
    expect(saved.ok && saved.applied).toEqual({
      added: [],
      changed: [],
      removed: ['OLD', 'OLD_SECRET'],
      errors: [],
    });
    expect([...host.repository.variables.keys()]).toEqual(['SAME']);
  });

  it('a secret needs a value, and a name GitHub does not allow is said so', async () => {
    const host = github();
    const saved = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [
        { key: 'EMPTY_SECRET', value: '', secured: true },
        { key: 'GITHUB_TOKEN', value: 'x', secured: false },
      ],
      remove: [],
    });
    expect(saved.ok && saved.applied.errors).toEqual([
      'EMPTY_SECRET: a secret needs a value.',
      'GITHUB_TOKEN is not allowed: letters, digits and underscores, not starting with a digit or GITHUB_.',
    ]);
  });

  it('saving to an environment GitHub does not have makes it, then writes there', async () => {
    const host = github();
    const saved = await applyGithubVariables(
      host.auth,
      'acme/app',
      { name: 'dev', production: false },
      { set: [{ key: 'DB_PASSWORD', value: 'pw', secured: true }], remove: [] }
    );
    expect(saved).toMatchObject({ ok: true, created: true });
    expect(host.sets.get('dev')?.secrets.get('DB_PASSWORD')).toBe('pw');
    expect(host.repository.secrets.size).toBe(0);
  });

  it('one refusal names its variable and the rest still lands', async () => {
    const host = github({ refuse: 'LOCKED_DOWN' });
    host.repository.variables.set('LOCKED_DOWN', 'old');
    const saved = await applyGithubVariables(host.auth, 'acme/app', null, {
      set: [
        { key: 'LOCKED_DOWN', value: 'new', secured: false },
        { key: 'FINE', value: '1', secured: false },
      ],
      remove: [],
    });
    expect(saved.ok && saved.applied.added).toEqual(['FINE']);
    expect(saved.ok && saved.applied.errors[0]).toMatch(/^LOCKED_DOWN: /);
    expect(host.repository.variables.get('LOCKED_DOWN')).toBe('old');
  });
});

// ——— Bitbucket, stood in for ———

interface BitbucketVariable {
  uuid: string;
  key: string;
  value: string;
  secured: boolean;
}

function bitbucket() {
  const repository: BitbucketVariable[] = [];
  const environments: {
    uuid: string;
    name: string;
    type: string;
    variables: BitbucketVariable[];
  }[] = [];
  let next = 1;
  const wire = (v: BitbucketVariable) => ({
    uuid: v.uuid,
    key: v.key,
    secured: v.secured,
    // Bitbucket never sends a secured value back.
    ...(v.secured ? {} : { value: v.value }),
  });
  const auth: BitbucketAuth = {
    kind: 'pat',
    async fetch(_scopes, pathAndQuery, init) {
      const method = init?.method ?? 'GET';
      const path = pathAndQuery.split('?')[0]!;
      const body = asRecord(init?.json);
      if (path === '/repositories/acme/app/environments') {
        if (method === 'POST') {
          const type = text(asRecord(body.environment_type).name);
          const made = { uuid: `{env-${next++}}`, name: String(body.name), type, variables: [] };
          environments.push(made);
          return json({ uuid: made.uuid, name: made.name }, 201);
        }
        return json({
          values: environments.map((e) => ({
            uuid: e.uuid,
            name: e.name,
            environment_type: { name: e.type },
          })),
        });
      }
      const scoped =
        /^\/repositories\/acme\/app\/(?:pipelines_config|deployments_config\/environments\/([^/]+))\/variables(?:\/([^/]+))?$/.exec(
          path
        );
      if (!scoped) return missing();
      const list = scoped[1]
        ? environments.find((e) => e.uuid === decodeURIComponent(scoped[1]!))?.variables
        : repository;
      if (!list) return missing();
      const uuid = scoped[2] ? decodeURIComponent(scoped[2]) : null;
      if (!uuid && method === 'GET') return json({ values: list.map(wire) });
      if (!uuid && method === 'POST') {
        const made = {
          uuid: `{v-${next++}}`,
          key: String(body.key),
          value: String(body.value ?? ''),
          secured: body.secured === true,
        };
        list.push(made);
        return json(wire(made), 201);
      }
      const found = list.find((v) => v.uuid === uuid);
      if (!found) return missing();
      if (method === 'PUT') {
        found.secured = body.secured === true;
        if (typeof body.value === 'string') found.value = body.value;
        return json(wire(found));
      }
      if (method === 'DELETE') {
        list.splice(list.indexOf(found), 1);
        return empty();
      }
      return missing();
    },
  };
  return { auth, repository, environments };
}

describe('Bitbucket Pipelines variables', () => {
  it('lists plain variables with their values and secured ones by name only', async () => {
    const host = bitbucket();
    host.repository.push(
      { uuid: '{a}', key: 'REGION', value: 'eu-west-1', secured: false },
      { uuid: '{b}', key: 'DEPLOY_TOKEN', value: 'never shown', secured: true }
    );
    const page = await readBitbucketVariables(host.auth, 'acme/app', 'Production');
    expect(page.repository.variables).toEqual([
      { key: 'DEPLOY_TOKEN', value: null, secured: true },
      { key: 'REGION', value: 'eu-west-1', secured: false },
    ]);
    expect(page.environment).toEqual({
      name: 'Production',
      exists: false,
      variables: [],
      error: null,
    });
  });

  it('finds the deployment environment by name, whatever its case', async () => {
    const host = bitbucket();
    host.environments.push({
      uuid: '{prod}',
      name: 'Production',
      type: 'Production',
      variables: [{ uuid: '{x}', key: 'URL', value: 'https://prod', secured: false }],
    });
    const page = await readBitbucketVariables(host.auth, 'acme/app', 'production');
    expect(page.environment).toMatchObject({
      exists: true,
      variables: [{ key: 'URL', value: 'https://prod', secured: false }],
    });
  });

  it('saves a locked row secured, changes what differs and removes what is named', async () => {
    const host = bitbucket();
    host.repository.push(
      { uuid: '{a}', key: 'REGION', value: 'eu-west-1', secured: false },
      { uuid: '{b}', key: 'OLD', value: 'x', secured: false },
      { uuid: '{c}', key: 'SAME', value: '1', secured: false }
    );
    const saved = await applyBitbucketVariables(host.auth, 'acme/app', null, {
      set: [
        { key: 'REGION', value: 'us-east-1', secured: false },
        { key: 'SAME', value: '1', secured: false },
        { key: 'DEPLOY_TOKEN', value: 'tok', secured: true },
      ],
      remove: ['OLD', 'NEVER_THERE'],
    });
    expect(saved).toEqual({
      ok: true,
      created: false,
      applied: { added: ['DEPLOY_TOKEN'], changed: ['REGION'], removed: ['OLD'], errors: [] },
    });
    expect(host.repository.map((v) => [v.key, v.value, v.secured])).toEqual([
      ['REGION', 'us-east-1', false],
      ['SAME', '1', false],
      ['DEPLOY_TOKEN', 'tok', true],
    ]);
  });

  it('a new secret needs a value; unlocking one needs it typed again', async () => {
    const host = bitbucket();
    host.repository.push({ uuid: '{a}', key: 'TOKEN', value: 'kept', secured: true });
    const saved = await applyBitbucketVariables(host.auth, 'acme/app', null, {
      set: [
        { key: 'NEW_SECRET', value: '', secured: true },
        { key: 'TOKEN', value: '', secured: false },
      ],
      remove: [],
    });
    expect(saved.ok && saved.applied.errors).toEqual([
      'NEW_SECRET: a new secret needs a value.',
      'TOKEN: its value is secret and cannot be read back; type it again to make it plain.',
    ]);
    expect(host.repository).toEqual([{ uuid: '{a}', key: 'TOKEN', value: 'kept', secured: true }]);
  });

  it('saving to an environment Bitbucket does not have makes it: Production for the production one, Test for any other', async () => {
    const host = bitbucket();
    const dev = await applyBitbucketVariables(
      host.auth,
      'acme/app',
      { name: 'dev', production: false },
      { set: [{ key: 'URL', value: 'https://dev', secured: false }], remove: [] }
    );
    expect(dev).toMatchObject({ ok: true, created: true });
    await applyBitbucketVariables(
      host.auth,
      'acme/app',
      { name: 'live', production: true },
      { set: [], remove: [] }
    );
    expect(host.environments.map((e) => [e.name, e.type, e.variables.length])).toEqual([
      ['dev', 'Test', 1],
      ['live', 'Production', 0],
    ]);
    // The repository's own set is untouched.
    expect(host.repository).toEqual([]);
  });
});

describe('a change as the page sends it', () => {
  it('is names to set, each with a value and whether it is a secret, and names to remove', () => {
    expect(
      readVariableChanges({
        set: [
          { key: ' API_URL ', value: 'x', secured: false },
          { key: 'TOKEN', value: 't', secured: true },
        ],
        remove: ['OLD', 'OLD'],
      })
    ).toEqual({
      ok: true,
      changes: {
        set: [
          { key: 'API_URL', value: 'x', secured: false },
          { key: 'TOKEN', value: 't', secured: true },
        ],
        remove: ['OLD'],
      },
    });
  });

  it('is refused whole when a name is not one, is given twice, or is both set and removed', () => {
    const message = (body: unknown) => {
      const read = readVariableChanges(body);
      return read.ok ? null : read.message;
    };
    expect(message({ set: [{ key: '1BAD', value: 'x' }] })).toMatch(/is not a variable name/);
    expect(
      message({
        set: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      })
    ).toBe('A is set twice.');
    expect(message({ set: [{ key: 'A', value: '1' }], remove: ['A'] })).toBe(
      'A is both set and removed.'
    );
    expect(message({ set: [{ key: 'A', value: 'x'.repeat(40_000) }] })).toBe(
      'A: the value is too long.'
    );
    expect(message({})).toBe('Nothing was changed.');
    expect(message('secret TOKEN=abc')).toBe('Nothing was changed.');
  });

  it('may change nothing only when it is there to make the environment', () => {
    expect(readVariableChanges({ set: [], remove: [] }, { allowEmpty: true })).toEqual({
      ok: true,
      changes: { set: [], remove: [] },
    });
  });
});
