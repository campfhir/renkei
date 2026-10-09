import { RUN_HEADER, currentRunId, runIdFromHeaders, withRun } from './run-context';

describe('run context', () => {
  it('takes a well-formed run id off the header and nothing else', () => {
    const id = '0f6b1b0e-7c3e-4b1a-9d2f-1234567890ab';
    expect(runIdFromHeaders(new Headers({ [RUN_HEADER]: id.toUpperCase() }))).toBe(id);
    expect(runIdFromHeaders(new Headers({ [RUN_HEADER]: 'run-42' }))).toBeUndefined();
    expect(runIdFromHeaders(new Headers())).toBeUndefined();
  });

  it('is visible across awaits inside withRun and absent outside it', async () => {
    const id = '0f6b1b0e-7c3e-4b1a-9d2f-1234567890ab';
    expect(currentRunId()).toBeUndefined();
    const seen = await withRun(id, async () => {
      await Promise.resolve();
      return currentRunId();
    });
    expect(seen).toBe(id);
    expect(currentRunId()).toBeUndefined();
    expect(withRun(undefined, () => currentRunId())).toBeUndefined();
  });
});
