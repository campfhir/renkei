/**
 * `rewrap --aad` (audit R-04): rows sealed before the AAD release are
 * re-sealed as v3 envelopes bound to their purpose (and connector); a
 * second run is a no-op; targets without a purpose are untouched; and a
 * plain key rotation afterwards keeps the binding.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  AAD_PURPOSE,
  aadFor,
  decrypt,
  encrypt,
  envelopeKeyId,
  isBoundEnvelope,
  keyId,
  parseKeyring,
  revealContent,
} from '@renkei/crypto';
import { rewrapAll, type RewrapRings } from './rewrap';

describe('rewrap --aad', () => {
  const oldEncoded = randomBytes(32).toString('base64');
  const newEncoded = randomBytes(32).toString('base64');
  const oldRing = parseKeyring(oldEncoded);
  const ring = parseKeyring(oldEncoded);
  const rotated = parseKeyring(`${newEncoded},${oldEncoded}`);
  if (!oldRing.ok || !ring.ok || !rotated.ok) throw new Error('keys');
  const rings: RewrapRings = { token: ring.val, content: ring.val, sandbox: ring.val };
  const modelId = randomUUID();
  const chunkRef = `aad-${randomUUID()}`;

  beforeAll(async () => {
    registerDataStore(createMemoryDataStore());
    const store = getDataStore();
    await store.oidcConfig.save({
      id: randomUUID(),
      issuer: 'https://idp.test',
      clientId: 'client',
      clientSecret: encrypt('oidc-secret', oldRing.val),
      operatorIdpValue: null,
      userIdpValue: null,
      groupsClaim: null,
    });
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
    await store.connectorConfigs.upsert({
      connector: 'github',
      enabled: true,
      settings: {},
      encryptedSecrets: encrypt(JSON.stringify({ s: 'gh' }), oldRing.val),
    });
    await store.knowledgeChunks.upsert({
      provider: 'test',
      refId: chunkRef,
      metadata: {},
      content: `renc1:${encrypt('chunk body', oldRing.val)}`,
      embedding: [],
      keywords: null,
      search: { title: '', keywords: '', content: '', config: 'simple' },
      sourceAt: null,
    });
    await store.sandboxEnvSecrets.upsert({
      id: randomUUID(),
      subject: 'alice',
      name: 'NPM_TOKEN',
      sealed: `env1.${encrypt('npm-token', oldRing.val)}`,
      updatedAt: new Date(),
    });
  });

  afterAll(() => resetDataStore());

  async function read() {
    const store = getDataStore();
    const oidc = await store.oidcConfig.get();
    const model = await store.llmModels.get(modelId);
    const [github] = await store.connectorConfigs.list();
    const [env] = await store.sandboxEnvSecrets.listSealed('alice');
    if (!oidc || !model || !github || !env) throw new Error('fixture rows missing');
    return { oidc, model, github, env };
  }

  it('a dry run changes nothing', async () => {
    const before = await read();
    const report = await rewrapAll(rings, { aad: true, dryRun: true });
    expect(report.targets['connector_configs.encrypted_secrets']?.rewrapped).toBe(1);
    expect(await read()).toEqual(before);
  });

  it('binds legacy rows to their purpose and leaves targets without one alone', async () => {
    const before = await read();
    const report = await rewrapAll(rings, { aad: true });
    expect(report.targets['sandbox_env_secrets.sealed']?.rewrapped).toBe(0);
    const after = await read();
    expect(after.env).toEqual(before.env);

    const github = after.github.encryptedSecrets;
    expect(isBoundEnvelope(github)).toBe(true);
    expect(decrypt(github, ring.val, aadFor(AAD_PURPOSE.connectorConfig, 'github'))).toEqual({
      ok: true,
      val: JSON.stringify({ s: 'gh' }),
    });
    // Another connector's row, or any other purpose, cannot open it.
    expect(decrypt(github, ring.val, aadFor(AAD_PURPOSE.connectorConfig, 'jira')).ok).toBe(false);
    expect(decrypt(github, ring.val, aadFor(AAD_PURPOSE.llmModelKey)).ok).toBe(false);

    expect(
      decrypt(after.model.encryptedSecrets, ring.val, aadFor(AAD_PURPOSE.llmModelKey)).ok
    ).toBe(true);
    expect(
      decrypt(after.oidc.clientSecret, ring.val, aadFor(AAD_PURPOSE.oidcClientSecret)).ok
    ).toBe(true);

    const [chunk] = await getDataStore().knowledgeChunks.listByRefPrefix('test', chunkRef);
    expect(chunk?.content.startsWith('renc1:v3.')).toBe(true);
    expect(revealContent(chunk?.content ?? '', ring.val)).toBe('chunk body');
    // The connector blob moved into a chunk is not revealed.
    expect(revealContent(`renc1:${github}`, ring.val)).toBe(
      '[content unavailable: decryption failed]'
    );
  });

  it('a second run has nothing left to do', async () => {
    const report = await rewrapAll(rings, { aad: true });
    for (const counts of Object.values(report.targets)) expect(counts.rewrapped).toBe(0);
  });

  it('a plain rotation afterwards keeps the binding and the rows open', async () => {
    const report = await rewrapAll({
      token: rotated.val,
      content: rotated.val,
      sandbox: rotated.val,
    });
    expect(report.targets['connector_configs.encrypted_secrets']).toEqual({
      rewrapped: 1,
      skipped: 0,
      unreadable: [],
    });
    const after = await read();
    const github = after.github.encryptedSecrets;
    expect(isBoundEnvelope(github)).toBe(true);
    expect(envelopeKeyId(github)).toBe(keyId(rotated.val));
    expect(decrypt(github, rotated.val, aadFor(AAD_PURPOSE.connectorConfig, 'github')).ok).toBe(
      true
    );
    // Rotating again finds the rows already current: bound rows are skipped, not rewritten.
    const again = await rewrapAll({
      token: rotated.val,
      content: rotated.val,
      sandbox: rotated.val,
    });
    expect(again.targets['connector_configs.encrypted_secrets']?.rewrapped).toBe(0);
    expect(again.targets['oidc_config.client_secret']?.skipped).toBe(0);
  });
});
