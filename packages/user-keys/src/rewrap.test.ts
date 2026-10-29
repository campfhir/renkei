/**
 * The rotation sweep: rows sealed under the old key — as `v1`, and as `v2`
 * naming the old key — move to `v2` under the new key and still open;
 * rows already under the new key are left alone; a row no key of the
 * ring opens is reported and untouched; a dry run changes nothing; and a
 * second run finds nothing left to do.
 *
 * The sweep walks every sealed column of the deployment, and its counts
 * are exact, so it runs over a memory store holding only this test's rows
 * (the paging itself is the sealedEnvelopes domain's, covered by its
 * differential scenarios against Postgres). Rows are written with the
 * calls the settings pages make; the ciphertext stays opaque to the store.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  decrypt,
  encrypt,
  envelopeKeyId,
  keyId,
  parseEncryptionKey,
  parseKeyring,
} from '@renkei/crypto';
import { rewrapAll, rewrapRingsFromEnv, type RewrapRings } from './rewrap';

describe('rewrap under the current key of the ring', () => {
  const oldEncoded = randomBytes(32).toString('base64');
  const newEncoded = randomBytes(32).toString('base64');
  const strangerEncoded = randomBytes(32).toString('base64');
  const oldBare = parseEncryptionKey(oldEncoded);
  const oldRing = parseKeyring(oldEncoded);
  const newRing = parseKeyring(`${newEncoded},${oldEncoded}`);
  const stranger = parseKeyring(strangerEncoded);
  if (!oldBare.ok || !oldRing.ok || !newRing.ok || !stranger.ok) throw new Error('keys');
  const rings: RewrapRings = { token: newRing.val, content: newRing.val, sandbox: newRing.val };
  const modelId = randomUUID();
  const ruleIds: string[] = [];

  beforeAll(async () => {
    registerDataStore(createMemoryDataStore());
    const store = getDataStore();
    // v1 under the old key (a bare key writes v1, as every row from before rings is).
    await store.oidcConfig.save({
      id: randomUUID(),
      issuer: 'https://idp.test',
      clientId: 'client',
      clientSecret: encrypt('oidc-secret', oldBare.val),
      operatorIdpValue: null,
      userIdpValue: null,
      groupsClaim: null,
    });
    // v2 naming the old key.
    await store.llmModels.create(modelId, {
      label: 'test',
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: null,
      settings: {},
      encryptedSecrets: encrypt(JSON.stringify({ apiKey: 'sk-test' }), oldRing.val),
      enabled: true,
      isDefault: false,
    });
    // A composite-key table: one row under the old key, one already current.
    await store.connectorConfigs.upsert({
      connector: 'rewrap-old',
      enabled: true,
      settings: {},
      encryptedSecrets: encrypt(JSON.stringify({ s: 'old' }), oldBare.val),
    });
    await store.connectorConfigs.upsert({
      connector: 'rewrap-current',
      enabled: true,
      settings: {},
      encryptedSecrets: encrypt(JSON.stringify({ s: 'current' }), newRing.val),
    });
    // Prefixed envelopes on the sandbox ring; one sealed under a key no ring holds.
    await store.sandboxEnvSecrets.upsert({
      id: randomUUID(),
      subject: 'alice',
      name: 'NPM_TOKEN',
      sealed: `env1.${encrypt('npm-token', oldBare.val)}`,
      updatedAt: new Date(),
    });
    for (const [pattern, sealed] of [
      ['rewrap.test/old/*', `reg1.${encrypt('pull-token', oldRing.val)}`],
      ['rewrap.test/stranger/*', `reg1.${encrypt('lost', stranger.val)}`],
    ] as const) {
      const rule = await store.codeServiceImageRules.insert({
        pattern,
        note: null,
        registryUsername: 'u',
        registrySealed: sealed,
      });
      ruleIds.push(rule.id);
    }
  });

  afterAll(() => resetDataStore());

  async function stored() {
    const store = getDataStore();
    const oidc = await store.oidcConfig.get();
    const model = await store.llmModels.get(modelId);
    if (!oidc || !model) throw new Error('fixture rows missing');
    const connectors = await store.connectorConfigs.list();
    const [env] = await store.sandboxEnvSecrets.listSealed('alice');
    if (!env) throw new Error('fixture env secret missing');
    const rules = await store.codeServiceImageRules.listForMatching();
    return { oidc, model, connectors, env, rules };
  }

  it('a dry run counts and changes nothing', async () => {
    const before = await stored();
    const report = await rewrapAll(rings, { dryRun: true });
    expect(report.targets['oidc_config.client_secret']?.rewrapped).toBe(1);
    expect(report.targets['llm_model_configs.encrypted_secrets']?.rewrapped).toBe(1);
    expect(report.targets['connector_configs.encrypted_secrets']?.rewrapped).toBe(1);
    expect(report.targets['sandbox_env_secrets.sealed']?.rewrapped).toBe(1);
    expect(report.targets['code_service_image_rules.registry_sealed']).toMatchObject({
      rewrapped: 1,
      skipped: 1,
    });
    expect(await stored()).toEqual(before);
  });

  it('moves v1 and old-kid rows under the current key, and they still open', async () => {
    const lines: string[] = [];
    const report = await rewrapAll(rings, { log: (line) => lines.push(line) });
    expect(report.targets['oidc_config.client_secret']).toEqual({
      rewrapped: 1,
      skipped: 0,
      unreadable: [],
    });
    const after = await stored();
    const current = keyId(newRing.val);
    expect(envelopeKeyId(after.oidc.clientSecret)).toBe(current);
    expect(decrypt(after.oidc.clientSecret, newRing.val)).toEqual({
      ok: true,
      val: 'oidc-secret',
    });
    expect(envelopeKeyId(after.model.encryptedSecrets)).toBe(current);
    expect(decrypt(after.model.encryptedSecrets, newRing.val)).toEqual({
      ok: true,
      val: JSON.stringify({ apiKey: 'sk-test' }),
    });
    expect(after.connectors.map((c) => envelopeKeyId(c.encryptedSecrets))).toEqual([
      current,
      current,
    ]);
    expect(after.env.sealed.startsWith('env1.v2.')).toBe(true);
    expect(decrypt(after.env.sealed.slice('env1.'.length), newRing.val)).toEqual({
      ok: true,
      val: 'npm-token',
    });
    // The row under the stranger's key is reported and untouched.
    const [oldRule, strangerRule] = after.rules;
    expect(envelopeKeyId(oldRule?.registrySealed?.slice('reg1.'.length) ?? '')).toBe(current);
    expect(envelopeKeyId(strangerRule?.registrySealed?.slice('reg1.'.length) ?? '')).toBe(
      keyId(stranger.val)
    );
    const rules = report.targets['code_service_image_rules.registry_sealed'];
    expect(rules).toMatchObject({ rewrapped: 1, skipped: 1 });
    expect(rules?.unreadable).toEqual([ruleIds[1]]);
    expect(lines.some((line) => line.includes('no key of the ring opens it'))).toBe(true);
    // The key the rows were under is no longer named anywhere this run touched.
    expect(lines.join('\n')).not.toContain(keyId(oldRing.val));
  });

  it('a second run finds nothing left but the row nobody can open', async () => {
    const report = await rewrapAll(rings);
    for (const [name, counts] of Object.entries(report.targets)) {
      expect({ name, rewrapped: counts.rewrapped }).toEqual({ name, rewrapped: 0 });
    }
    expect(report.targets['code_service_image_rules.registry_sealed']?.skipped).toBe(1);
  });

  it('reads the three rings from the environment with their fallbacks', () => {
    const fromToken = rewrapRingsFromEnv({ TOKEN_ENCRYPTION_KEYS: `${newEncoded},${oldEncoded}` });
    expect(fromToken.ok).toBe(true);
    if (fromToken.ok) {
      expect(keyId(fromToken.val.token)).toBe(keyId(newRing.val));
      expect(keyId(fromToken.val.content)).toBe(keyId(newRing.val));
      expect(keyId(fromToken.val.sandbox)).toBe(keyId(newRing.val));
    }
    const apart = rewrapRingsFromEnv({
      TOKEN_ENCRYPTION_KEY: oldEncoded,
      CONTENT_ENCRYPTION_KEYS: `${newEncoded},${oldEncoded}`,
      SANDBOX_ENV_SECRETS_KEY: strangerEncoded,
    });
    expect(apart.ok).toBe(true);
    if (apart.ok) {
      expect(keyId(apart.val.token)).toBe(keyId(oldRing.val));
      expect(keyId(apart.val.content)).toBe(keyId(newRing.val));
      expect(keyId(apart.val.sandbox)).toBe(keyId(stranger.val));
    }
    expect(rewrapRingsFromEnv({}).ok).toBe(false);
  });
});
