import { sealSandboxEnv } from '@renkei/connector-sandbox';
import type { DataStore } from '@renkei/db';
import { sealedBoot } from './sealed-boot';

const ID = '00000000-0000-4000-8000-000000000001';
const KEY = 'this-sandbox-key';
const SECRETS = { DELEGATE_WORKER_API_KEY: 'delegate-s3cret', SANDBOX_ENV_SECRETS_KEY: 'sealing' };

function sandboxEnv(): Record<string, string | undefined> {
  return {
    SANDBOX_ORCHESTRATED: '1',
    SANDBOX_INSTANCE_ID: ID,
    SANDBOX_WORKER_API_KEY: KEY,
    SANDBOX_ORCHESTRATOR_CALLBACK_URL: 'http://orchestrator:8097/',
  };
}

/** An orchestrator that answers `sealed`, after `failures` refusals. */
function orchestrator(sealed: string, failures = 0) {
  const asked: Array<{ url: string; headers: Headers }> = [];
  let left = failures;
  const answer: typeof fetch = async (input, init) => {
    asked.push({ url: String(input), headers: new Headers(init?.headers) });
    if (left > 0) {
      left -= 1;
      throw new Error('ECONNREFUSED');
    }
    return new Response(JSON.stringify({ sealed }), { status: 200 });
  };
  return { asked, answer };
}

const quick = { sleep: async () => undefined };

describe('a sandbox the orchestrator made, starting up', () => {
  it('asks the orchestrator for what it is started with, as itself, and opens it with its own key', async () => {
    const env = sandboxEnv();
    const { asked, answer } = orchestrator(sealSandboxEnv(KEY, ID, SECRETS));
    const registered: DataStore[] = [];
    const mode = await sealedBoot({
      env,
      fetch: answer,
      ...quick,
      register: (store) => void registered.push(store),
    });
    expect(mode).toBe('sandbox');
    expect(asked[0]?.url).toBe('http://orchestrator:8097/sandbox/v1/bootstrap');
    expect(asked[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(asked[0]?.headers.get('x-sandbox-id')).toBe(ID);
    expect(env.DELEGATE_WORKER_API_KEY).toBe('delegate-s3cret');
    expect(env.SANDBOX_ENV_SECRETS_KEY).toBe('sealing');
  });

  it('uses the orchestrator as its data store and keeps no database URL, even one it was handed', async () => {
    const env = { ...sandboxEnv(), DATABASE_URL: 'postgres://left-in-by-mistake' };
    const { answer } = orchestrator(
      sealSandboxEnv(KEY, ID, { ...SECRETS, DATABASE_URL: 'postgres://also-not-kept' })
    );
    const registered: DataStore[] = [];
    await sealedBoot({
      env,
      fetch: answer,
      ...quick,
      register: (store) => void registered.push(store),
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(registered.map((store) => store.kind)).toEqual(['remote']);
  });

  it('keeps what it was created with over anything it is handed', async () => {
    const env = sandboxEnv();
    const { answer } = orchestrator(
      sealSandboxEnv(KEY, ID, { SANDBOX_WORKER_API_KEY: 'another-key', SANDBOX_INSTANCE_ID: 'x' })
    );
    await sealedBoot({ env, fetch: answer, ...quick, register: () => undefined });
    expect(env.SANDBOX_WORKER_API_KEY).toBe(KEY);
    expect(env.SANDBOX_INSTANCE_ID).toBe(ID);
  });

  it('waits for an orchestrator that is a moment behind', async () => {
    const env = sandboxEnv();
    const { asked, answer } = orchestrator(sealSandboxEnv(KEY, ID, SECRETS), 3);
    await sealedBoot({ env, fetch: answer, ...quick, register: () => undefined });
    expect(asked).toHaveLength(4);
    expect(env.DELEGATE_WORKER_API_KEY).toBe('delegate-s3cret');
  });

  it('does not start on an environment sealed for another sandbox, or changed on the way', async () => {
    const forAnother = orchestrator(sealSandboxEnv('another-key', ID, SECRETS));
    const env = sandboxEnv();
    await expect(
      sealedBoot({ env, fetch: forAnother.answer, ...quick, register: () => undefined })
    ).rejects.toThrow(/not sealed for this sandbox/);
    expect(env.DELEGATE_WORKER_API_KEY).toBeUndefined();
  });

  it('does not start when the orchestrator never answers, and says where it asked', async () => {
    const { answer } = orchestrator('unused', 1_000);
    await expect(
      sealedBoot({ env: sandboxEnv(), fetch: answer, ...quick, register: () => undefined })
    ).rejects.toThrow(/orchestrator at http:\/\/orchestrator:8097 did not hand this sandbox/);
  });

  it('does not start without its id, its key or the orchestrator’s address', async () => {
    const env = sandboxEnv();
    delete env.SANDBOX_ORCHESTRATOR_CALLBACK_URL;
    await expect(sealedBoot({ env, ...quick })).rejects.toThrow(/made without/);
  });
});

describe('a worker many callers share', () => {
  it('starts as it always did: its own environment, its own database role, nobody asked', async () => {
    const env = { DATABASE_URL: 'postgres://shared' };
    const { asked, answer } = orchestrator('unused');
    const registered: DataStore[] = [];
    expect(
      await sealedBoot({ env, fetch: answer, register: (store) => void registered.push(store) })
    ).toBe('shared');
    expect(asked).toEqual([]);
    expect(registered).toEqual([]);
    expect(env.DATABASE_URL).toBe('postgres://shared');
  });
});
