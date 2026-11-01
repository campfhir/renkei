/**
 * The ADManager Plus registry and its instance draft
 * (instance-list.model.ts), as an operator would describe them. These were
 * admanager.spec.ts's form steps; what the registry routes store and
 * refuse is app/api/admin/admanager/route.test.ts.
 */

import {
  canCreate,
  canTest,
  caPlaceholder,
  draftPayload,
  editDraft,
  emptyDraft,
  initialInstanceList,
  instanceListReducer,
  probeBody,
  probeText,
  showsEmpty,
  urlPreview,
  type InstanceListAction,
  type InstanceRow,
} from './instance-list.model';

const run = (actions: InstanceListAction[]) =>
  actions.reduce(instanceListReducer, initialInstanceList);

const row = (id: string): InstanceRow => ({
  id,
  name: `ADManager ${id}`,
  environment: 'prod',
  baseUrl: 'https://admp.example.com:8080',
  tlsVerify: true,
  enabled: true,
});

describe('a new instance', () => {
  it('starts labelled production, verifying its certificate, plaintext off, enabled', () => {
    expect(emptyDraft()).toMatchObject({
      environment: 'prod',
      tlsVerify: true,
      allowInsecureHttp: false,
      enabled: true,
    });
  });

  it('Create needs a name and a server URL', () => {
    const open = run([{ type: 'new' }]);
    expect(canCreate(open)).toBe(false);
    const named = instanceListReducer(open, { type: 'edit', patch: { name: 'Prod' } });
    expect(canCreate(named)).toBe(false);
    expect(canTest(named)).toBe(false);
    const ready = instanceListReducer(named, {
      type: 'edit',
      patch: { baseUrl: 'https://admp.example.com:8080' },
    });
    expect(canCreate(ready)).toBe(true);
    expect(canTest(ready)).toBe(true);
  });

  it('a whitespace name or URL does not count', () => {
    const state = run([{ type: 'new' }, { type: 'edit', patch: { name: '  ', baseUrl: ' ' } }]);
    expect(canCreate(state)).toBe(false);
    expect(canTest(state)).toBe(false);
  });

  it('nothing can be pressed twice while a test or create is in flight', () => {
    const state = run([
      { type: 'new' },
      { type: 'edit', patch: { name: 'Prod', baseUrl: 'https://a.example' } },
      { type: 'testing' },
    ]);
    expect(canCreate(state)).toBe(false);
    expect(canTest(state)).toBe(false);
  });
});

describe('what Create sends', () => {
  it('sends the reset-password template trimmed, and a blank one as null so an edit can clear it', () => {
    const typed = editDraft(emptyDraft(), {
      name: 'Prod',
      baseUrl: 'https://admp.example.com:8080',
      resetPasswordTemplateName: ' Reset Password – must change at next logon ',
    });
    expect(draftPayload(typed)).toEqual({
      name: 'Prod',
      environment: 'prod',
      baseUrl: 'https://admp.example.com:8080',
      tlsVerify: true,
      allowInsecureHttp: false,
      resetPasswordTemplateName: 'Reset Password – must change at next logon',
      enabled: true,
    });
    expect(draftPayload(emptyDraft()).resetPasswordTemplateName).toBeNull();
  });

  it('leaves the CA out to keep the stored one, sends a pasted one, and null to remove it', () => {
    expect(draftPayload(emptyDraft())).not.toHaveProperty('caPem');
    expect(draftPayload(editDraft(emptyDraft(), { caPem: '---PEM---' })).caPem).toBe('---PEM---');
    expect(draftPayload(editDraft(emptyDraft(), { caPem: '   ' }))).not.toHaveProperty('caPem');
    const stored = { ...emptyDraft(), hasCustomCa: true };
    expect(draftPayload(editDraft(stored, { clearCa: true })).caPem).toBeNull();
  });

  it('pasting a CA undoes "remove the stored CA", and ticking remove empties the paste', () => {
    const stored = { ...emptyDraft(), hasCustomCa: true };
    const removing = editDraft(editDraft(stored, { caPem: 'x' }), { clearCa: true });
    expect(removing).toMatchObject({ clearCa: true, caPem: '' });
    expect(editDraft(removing, { caPem: 'y' })).toMatchObject({ clearCa: false, caPem: 'y' });
  });

  it('the CA field says one is stored until removing it is chosen', () => {
    const stored = { ...emptyDraft(), hasCustomCa: true };
    expect(caPlaceholder(stored)).toMatch(/A CA certificate is stored/);
    expect(caPlaceholder({ ...stored, clearCa: true })).toBe('-----BEGIN CERTIFICATE-----');
    expect(caPlaceholder(emptyDraft())).toBe('-----BEGIN CERTIFICATE-----');
  });
});

describe('the server URL preview', () => {
  it('explains where the API is reached before anything is typed', () => {
    expect(urlPreview(emptyDraft())).toEqual({
      text: 'The REST API is reached at <server URL>/api/v1 and /api/v2.',
      error: false,
    });
  });

  it('shows the API paths for an https URL', () => {
    const preview = urlPreview({ ...emptyDraft(), baseUrl: 'https://admp.example.com:8080' });
    expect(preview.error).toBe(false);
    expect(preview.text).toMatch(/^REST API at https:\/\/admp\.example\.com:8080\/api\/v1/);
  });

  it('refuses plain http unless insecure HTTP is allowed', () => {
    const http = { ...emptyDraft(), baseUrl: 'http://127.0.0.1:8080' };
    expect(urlPreview(http)).toEqual({
      text: 'Must be an https URL — or allow insecure HTTP below for a plaintext lab server.',
      error: true,
    });
    expect(urlPreview({ ...http, allowInsecureHttp: true }).error).toBe(false);
  });
});

describe('testing reachability', () => {
  it('sends the transport settings of the unsaved draft, a blank CA left out', () => {
    const draft = { ...emptyDraft(), name: 'n', baseUrl: 'https://a.example', tlsVerify: false };
    expect(probeBody(draft)).toEqual({
      baseUrl: 'https://a.example',
      tlsVerify: false,
      caPem: undefined,
      allowInsecureHttp: false,
    });
  });

  it('reads a 401 as a healthy API asking for a token, any other answer by its status', () => {
    expect(probeText({ ok: true, status: 401 })).toMatch(/REST API is listening/);
    expect(probeText({ ok: true, status: 200 })).toBe('Reachable — the server answered 200.');
  });

  it('shows why it was not reached, or says so plainly', () => {
    expect(probeText({ ok: false, error: 'Connection refused' })).toBe('Connection refused');
    expect(probeText({ ok: false })).toBe('The server could not be reached.');
  });

  it('a refused test (the service not configured) shows the reason and keeps the draft', () => {
    const state = run([
      { type: 'new' },
      { type: 'edit', patch: { name: 'Prod', baseUrl: 'https://a.example' } },
      { type: 'testing' },
      {
        type: 'test-failed',
        error: 'The ADManager Plus service is not configured on this deployment',
      },
    ]);
    expect(state.error).toMatch(/not configured/);
    expect(state.draft?.name).toBe('Prod');
    expect(state.busy).toBe(false);
  });

  it('a new test clears the last answer', () => {
    const state = run([
      { type: 'new' },
      { type: 'testing' },
      { type: 'tested', probe: { ok: true, status: 401 } },
      { type: 'testing' },
    ]);
    expect(state.probe).toBeNull();
  });
});

describe('the list', () => {
  it('says none are registered only with nothing listed and no form open', () => {
    expect(showsEmpty(initialInstanceList)).toBe(true);
    expect(showsEmpty(run([{ type: 'new' }]))).toBe(false);
    expect(showsEmpty(run([{ type: 'loaded', instances: [row('a')] }]))).toBe(false);
  });

  it('a created instance closes the form and its test answer', () => {
    const state = run([
      { type: 'new' },
      { type: 'tested', probe: { ok: true, status: 401 } },
      { type: 'creating' },
      { type: 'created' },
    ]);
    expect(state.draft).toBeNull();
    expect(state.probe).toBeNull();
  });

  it('a refused create (production over plaintext) keeps the draft and shows why', () => {
    const state = run([
      { type: 'new' },
      { type: 'edit', patch: { name: 'Lab', baseUrl: 'http://127.0.0.1:8080' } },
      { type: 'creating' },
      { type: 'create-failed', error: 'A production instance must use https …' },
    ]);
    expect(state.draft?.name).toBe('Lab');
    expect(state.error).toMatch(/production instance must use https/);
    // The next try clears it.
    expect(instanceListReducer(state, { type: 'creating' }).error).toBeNull();
  });

  it('cancel closes the form', () => {
    expect(run([{ type: 'new' }, { type: 'cancel' }]).draft).toBeNull();
  });

  it('an edit with no form open changes nothing', () => {
    expect(run([{ type: 'edit', patch: { name: 'x' } }])).toEqual(initialInstanceList);
  });
});
