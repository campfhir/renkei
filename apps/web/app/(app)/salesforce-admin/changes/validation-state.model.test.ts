import { VALIDATION_LABELS, validationState } from './validation-state.model';

const done = (success: boolean, deployId = '0Af000000000001') => ({
  deployId,
  done: true,
  success,
  status: success ? 'Succeeded' : 'Failed',
  failures: [],
  checkedAt: '',
});

describe('the validation badge', () => {
  it('says validated, checked, failed, running or not validated as before', () => {
    expect(validationState(done(true))).toBe('passed');
    expect(validationState(done(true, ''))).toBe('checked');
    expect(validationState(done(false))).toBe('failed');
    expect(validationState({ ...done(true), done: false })).toBe('running');
    expect(validationState({ error: 'timed out', checkedAt: '' })).toBe('error');
    expect(validationState(null)).toBe('none');
  });

  it('says tests short for Apex Salesforce passed under the coverage bar, not validated', () => {
    expect(validationState(done(true), true)).toBe('tests');
    expect(VALIDATION_LABELS.tests).toBe('Tests short');
  });

  it('says tests short when the deploy failed on its tests, and running while it still runs', () => {
    expect(validationState(done(false), true)).toBe('tests');
    expect(validationState({ ...done(false), done: false }, true)).toBe('running');
  });
});
