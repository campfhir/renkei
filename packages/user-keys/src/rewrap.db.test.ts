/**
 * The rotation sweep against a real database (skipped without
 * DATABASE_URL): rows sealed under the old key — as `v1`, and as `v2`
 * naming the old key — move to `v2` under the new key and still open;
 * rows already under the new key are left alone; a row no key of the
 * ring opens is reported and untouched; a dry run changes nothing; and a
 * second run finds nothing left to do.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import {
  decrypt,
  encrypt,
  envelopeKeyId,
  keyId,
  parseEncryptionKey,
  parseKeyring,
} from '@renkei/crypto';
import { rewrapAll, rewrapRingsFromEnv, type RewrapRings } from './rewrap';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('rewrap under the current key of the ring', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const oldEncoded = randomBytes(32).toString('base64');
  const newEncoded = randomBytes(32).toString('base64');
  const strangerEncoded = randomBytes(32).toString('base64');
  const oldBare = parseEncryptionKey(oldEncoded);
  const oldRing = parseKeyring(oldEncoded);
  const newRing = parseKeyring(`${newEncoded},${oldEncoded}`);
  const stranger = parseKeyring(strangerEncoded);
  if (!oldBare.ok || !oldRing.ok || !newRing.ok || !stranger.ok) throw new Error('keys');
  const rings: RewrapRings = { token: newRing.val, content: newRing.val, sandbox: newRing.val };
  const oidcId = randomUUID();
  const modelId = randomUUID();
  const envSecretId = randomUUID();
  const ruleIds: string[] = [];

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `rewrap-${tenantId.slice(0, 8)}` })
      .execute();
    // v1 under the old key (a bare key writes v1, as every row from before rings is).
    await db
      .insertInto('tenant_oidc')
      .values({
        id: oidcId,
        tenant_id: tenantId,
        issuer: 'https://idp.test',
        client_id: 'client',
        client_secret: encrypt('oidc-secret', oldBare.val),
      })
      .execute();
    // v2 naming the old key.
    await db
      .insertInto('llm_model_configs')
      .values({
        id: modelId,
        tenant_id: tenantId,
        provider: 'openai',
        model: 'gpt-test',
        label: 'test',
        encrypted_secrets: encrypt(JSON.stringify({ apiKey: 'sk-test' }), oldRing.val),
      })
      .execute();
    // A composite-key table: one row under the old key, one already current.
    await db
      .insertInto('connector_configs')
      .values([
        {
          tenant_id: tenantId,
          connector: 'rewrap-old',
          encrypted_secrets: encrypt(JSON.stringify({ s: 'old' }), oldBare.val),
        },
        {
          tenant_id: tenantId,
          connector: 'rewrap-current',
          encrypted_secrets: encrypt(JSON.stringify({ s: 'current' }), newRing.val),
        },
      ])
      .execute();
    // Prefixed envelopes on the sandbox ring; one sealed under a key no ring holds.
    await db
      .insertInto('sandbox_env_secrets')
      .values({
        id: envSecretId,
        tenant_id: tenantId,
        subject: 'alice',
        name: 'NPM_TOKEN',
        sealed: `env1.${encrypt('npm-token', oldBare.val)}`,
      })
      .execute();
    const rules = await db
      .insertInto('code_service_image_rules')
      .values([
        {
          tenant_id: tenantId,
          pattern: 'rewrap.test/old/*',
          registry_username: 'u',
          registry_sealed: `reg1.${encrypt('pull-token', oldRing.val)}`,
        },
        {
          tenant_id: tenantId,
          pattern: 'rewrap.test/stranger/*',
          registry_username: 'u',
          registry_sealed: `reg1.${encrypt('lost', stranger.val)}`,
        },
      ])
      .returning('id')
      .execute();
    ruleIds.push(...rules.map((r) => r.id));
  });

  afterAll(async () => {
    await db.deleteFrom('code_service_image_rules').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('sandbox_env_secrets').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('connector_configs').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('llm_model_configs').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('tenant_oidc').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  async function stored() {
    const oidc = await db
      .selectFrom('tenant_oidc')
      .select('client_secret')
      .where('id', '=', oidcId)
      .executeTakeFirstOrThrow();
    const model = await db
      .selectFrom('llm_model_configs')
      .select('encrypted_secrets')
      .where('id', '=', modelId)
      .executeTakeFirstOrThrow();
    const connectors = await db
      .selectFrom('connector_configs')
      .select(['connector', 'encrypted_secrets'])
      .where('tenant_id', '=', tenantId)
      .orderBy('connector')
      .execute();
    const env = await db
      .selectFrom('sandbox_env_secrets')
      .select('sealed')
      .where('id', '=', envSecretId)
      .executeTakeFirstOrThrow();
    const rules = await db
      .selectFrom('code_service_image_rules')
      .select(['pattern', 'registry_sealed'])
      .where('tenant_id', '=', tenantId)
      .orderBy('pattern')
      .execute();
    return { oidc, model, connectors, env, rules };
  }

  it('a dry run counts and changes nothing', async () => {
    const before = await stored();
    const report = await rewrapAll(db, rings, { dryRun: true });
    expect(report.targets['tenant_oidc.client_secret']?.rewrapped).toBe(1);
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
    const report = await rewrapAll(db, rings, { log: (line) => lines.push(line) });
    expect(report.targets['tenant_oidc.client_secret']).toEqual({
      rewrapped: 1,
      skipped: 0,
      unreadable: [],
    });
    const after = await stored();
    const current = keyId(newRing.val);
    expect(envelopeKeyId(after.oidc.client_secret)).toBe(current);
    expect(decrypt(after.oidc.client_secret, newRing.val)).toEqual({
      ok: true,
      val: 'oidc-secret',
    });
    expect(envelopeKeyId(after.model.encrypted_secrets)).toBe(current);
    expect(decrypt(after.model.encrypted_secrets, newRing.val)).toEqual({
      ok: true,
      val: JSON.stringify({ apiKey: 'sk-test' }),
    });
    expect(after.connectors.map((c) => envelopeKeyId(c.encrypted_secrets))).toEqual([
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
    expect(envelopeKeyId(oldRule!.registry_sealed!.slice('reg1.'.length))).toBe(current);
    expect(envelopeKeyId(strangerRule!.registry_sealed!.slice('reg1.'.length))).toBe(
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
    const report = await rewrapAll(db, rings);
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
