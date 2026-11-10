/**
 * The delegate's identity: a persistent instance derives the same keypair
 * and id from the same secret on every boot, registers once however often
 * it boots, and keeps its row on retire; an ephemeral one is new each boot
 * and takes its row with it. The development secret is refused in
 * production.
 */

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { keyVault } from '@renkei/user-keys';
import {
  developmentInstanceKeyRefusal,
  instanceIdentityOf,
  instanceIdOf,
  registerInstance,
} from './instance';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
});

afterEach(() => resetDataStore());

const live = async () => getDataStore().userKeys.liveInstances(new Date(Date.now() - 60_000));

describe('a persistent instance', () => {
  const env = { DELEGATE_INSTANCE_KEY: 'a configured secret of some length' };

  it('is the same instance on every boot and from every replica', async () => {
    const first = await registerInstance(logger, env);
    const firstId = keyVault()?.instanceId;
    expect(first.persistent).toBe(true);
    await first.retire();
    const second = await registerInstance(logger, env);
    expect(keyVault()?.instanceId).toBe(firstId);
    expect(keyVault()?.publicKey.equals(first.vault.publicKey)).toBe(true);
    expect((await live()).map((i) => i.id)).toEqual([firstId]);
    await second.retire();
  });

  it('keeps its row on retire, so its delegations outlive the process', async () => {
    const instance = await registerInstance(logger, env);
    await instance.retire();
    expect(await live()).toHaveLength(1);
  });

  it('derives a well-formed id from the public key, and a new one from a new secret', () => {
    const a = instanceIdentityOf(env);
    const b = instanceIdentityOf({ DELEGATE_INSTANCE_KEY: 'another secret' });
    expect(a?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a?.id).toBe(instanceIdOf(a!.pair.publicKey));
    expect(a?.id).not.toBe(b?.id);
    expect(instanceIdentityOf({ DELEGATE_INSTANCE_KEY: '  ' })).toBeNull();
    expect(instanceIdentityOf({})).toBeNull();
  });
});

describe('an ephemeral instance', () => {
  it('is new each boot and takes its row with it', async () => {
    const first = await registerInstance(logger, {});
    const firstId = keyVault()?.instanceId;
    expect(first.persistent).toBe(false);
    await first.retire();
    expect(await live()).toHaveLength(0);
    const second = await registerInstance(logger, {});
    expect(keyVault()?.instanceId).not.toBe(firstId);
    await second.retire();
  });
});

describe('the development instance key', () => {
  it('is refused in production and nowhere else', () => {
    const dev = { DELEGATE_INSTANCE_KEY: 'renkei-dev-delegate-instance-key' };
    expect(developmentInstanceKeyRefusal({ ...dev, NODE_ENV: 'production' })).toMatch(
      /development default/
    );
    expect(developmentInstanceKeyRefusal({ ...dev, NODE_ENV: 'development' })).toBeNull();
    expect(
      developmentInstanceKeyRefusal({ DELEGATE_INSTANCE_KEY: 'real', NODE_ENV: 'production' })
    ).toBeNull();
    expect(developmentInstanceKeyRefusal({ NODE_ENV: 'production' })).toBeNull();
  });
});
