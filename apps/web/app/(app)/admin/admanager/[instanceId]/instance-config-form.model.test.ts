/**
 * One ADManager Plus instance's edit page (instance-config-form.model.ts),
 * as an operator would describe it. These were admanager.spec.ts's edit
 * steps and banner checks (and the reason for its retry loops: a second
 * load putting the stored values back over an edit); what PATCH stores and
 * refuses is app/api/admin/admanager/route.test.ts.
 */

import {
  draftFromInstance,
  initialInstanceForm,
  instanceFormReducer,
  type InstanceFormAction,
  type InstanceFormState,
  type StoredInstance,
} from './instance-config-form.model';

const stored = (more: Partial<StoredInstance> = {}): StoredInstance => ({
  id: 'i-1',
  name: 'ADManager Plus lab',
  environment: 'lab',
  baseUrl: 'http://127.0.0.1:8080',
  tlsVerify: true,
  hasCustomCa: false,
  allowInsecureHttp: false,
  resetPasswordTemplateName: null,
  enabled: true,
  ...more,
});

const run = (actions: InstanceFormAction[], from: InstanceFormState = initialInstanceForm) =>
  actions.reduce(instanceFormReducer, from);

describe('loading', () => {
  it('shows nothing editable until the instance arrives, then its stored values', () => {
    expect(initialInstanceForm.draft).toBeNull();
    const state = run([
      {
        type: 'loaded',
        instance: stored({ resetPasswordTemplateName: 'Helpdesk Reset Template' }),
      },
    ]);
    expect(state.draft).toMatchObject({
      name: 'ADManager Plus lab',
      environment: 'lab',
      resetPasswordTemplateName: 'Helpdesk Reset Template',
      caPem: '',
      clearCa: false,
    });
  });

  it('an instance with no template opens with the field blank', () => {
    expect(draftFromInstance(stored()).resetPasswordTemplateName).toBe('');
  });

  it('a failed load says why', () => {
    expect(run([{ type: 'load-failed', error: 'Not found' }]).status).toEqual({
      kind: 'error',
      text: 'Not found',
    });
  });

  it('a load landing after the person started typing keeps what they typed', () => {
    const state = run([
      { type: 'loaded', instance: stored() },
      { type: 'edit', patch: { environment: 'staging' } },
      { type: 'loaded', instance: stored() },
    ]);
    expect(state.draft?.environment).toBe('staging');
  });

  it('after a save, the next load is the stored truth again', () => {
    const state = run([
      { type: 'loaded', instance: stored() },
      { type: 'edit', patch: { environment: 'staging' } },
      { type: 'sent' },
      { type: 'saved' },
      { type: 'loaded', instance: stored({ environment: 'staging-normalized' }) },
    ]);
    expect(state.draft?.environment).toBe('staging-normalized');
    expect(state.status).toEqual({ kind: 'ok', text: 'Saved.' });
  });
});

describe('the transport-security banner', () => {
  it('is absent while every protection is on', () => {
    expect(run([{ type: 'loaded', instance: stored() }]).insecure).toEqual([]);
  });

  it('names each protection the stored instance has off', () => {
    const state = run([
      { type: 'loaded', instance: stored({ allowInsecureHttp: true, tlsVerify: false }) },
    ]);
    expect(state.insecure).toEqual(['certificate verification off', 'plaintext HTTP allowed']);
  });

  it('follows what is stored, not what is typed', () => {
    const insecure = run([{ type: 'loaded', instance: stored({ allowInsecureHttp: true }) }]);
    const unticked = instanceFormReducer(insecure, {
      type: 'edit',
      patch: { allowInsecureHttp: false },
    });
    expect(unticked.insecure).toEqual(['plaintext HTTP allowed']);
    // Saved, and reloaded with the protection back on: the banner goes.
    const saved = run(
      [{ type: 'sent' }, { type: 'saved' }, { type: 'loaded', instance: stored() }],
      unticked
    );
    expect(saved.insecure).toEqual([]);
  });

  it('a load ignored for the draft still updates the banner', () => {
    const state = run([
      { type: 'loaded', instance: stored() },
      { type: 'edit', patch: { name: 'typing' } },
      { type: 'loaded', instance: stored({ tlsVerify: false }) },
    ]);
    expect(state.draft?.name).toBe('typing');
    expect(state.insecure).toEqual(['certificate verification off']);
  });
});

describe('saving, testing and deleting', () => {
  it('a refused save (relabelled production while insecure) keeps the edit and shows why', () => {
    const state = run([
      { type: 'loaded', instance: stored({ allowInsecureHttp: true }) },
      { type: 'edit', patch: { environment: 'prod' } },
      { type: 'sent' },
      { type: 'failed', error: 'A production instance must use https …' },
    ]);
    expect(state.draft?.environment).toBe('prod');
    expect(state.status).toEqual({ kind: 'error', text: 'A production instance must use https …' });
    expect(state.busy).toBe(false);
  });

  it('anything in flight disables the buttons and clears the last message', () => {
    const state = run([
      { type: 'loaded', instance: stored() },
      { type: 'failed', error: 'x' },
      { type: 'sent' },
    ]);
    expect(state.busy).toBe(true);
    expect(state.status).toBeNull();
  });

  it('a reachability answer reads green when reached and red when not', () => {
    const reached = run([{ type: 'sent' }, { type: 'tested', probe: { ok: true, status: 401 } }]);
    expect(reached.status?.kind).toBe('ok');
    const refused = run([{ type: 'sent' }, { type: 'tested', probe: { ok: false, error: 'no' } }]);
    expect(refused.status).toEqual({ kind: 'error', text: 'no' });
  });

  it('an edit before the instance arrives changes nothing', () => {
    expect(run([{ type: 'edit', patch: { name: 'x' } }])).toEqual(initialInstanceForm);
  });
});
