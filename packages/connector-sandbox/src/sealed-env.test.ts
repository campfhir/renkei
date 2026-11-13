import { openSandboxEnv, sealSandboxEnv } from './sealed-env';

const ENV = { DELEGATE_WORKER_API_KEY: 'delegate-s3cret', SANDBOX_ENV_SECRETS_KEY: 'k' };

describe('a sandbox’s sealed environment', () => {
  it('opens for the sandbox it was sealed for', () => {
    expect(openSandboxEnv('key-a', 'sandbox-a', sealSandboxEnv('key-a', 'sandbox-a', ENV))).toEqual(
      ENV
    );
  });

  it('shows nothing of what it holds to anyone reading it on the way', () => {
    const sealed = sealSandboxEnv('key-a', 'sandbox-a', ENV);
    expect(sealed).not.toContain('delegate-s3cret');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('delegate-s3cret');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain(
      'DELEGATE_WORKER_API_KEY'
    );
  });

  it('is different every time, so two answers cannot be told to hold the same thing', () => {
    expect(sealSandboxEnv('key-a', 'sandbox-a', ENV)).not.toBe(
      sealSandboxEnv('key-a', 'sandbox-a', ENV)
    );
  });

  it('does not open with another sandbox’s key, for another sandbox’s id, or once changed', () => {
    const sealed = sealSandboxEnv('key-a', 'sandbox-a', ENV);
    expect(openSandboxEnv('key-b', 'sandbox-a', sealed)).toBeNull();
    expect(openSandboxEnv('key-a', 'sandbox-b', sealed)).toBeNull();
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(openSandboxEnv('key-a', 'sandbox-a', raw.toString('base64'))).toBeNull();
    expect(openSandboxEnv('key-a', 'sandbox-a', 'not sealed at all')).toBeNull();
    expect(openSandboxEnv('key-a', 'sandbox-a', '')).toBeNull();
  });
});
