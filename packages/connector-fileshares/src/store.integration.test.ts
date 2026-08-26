/**
 * Store round-trip against a real Postgres with the migrated schema —
 * FILESHARE_TEST_DATABASE_URL (or DATABASE_URL) points at it; without one
 * the suite skips itself. Live SQL is the point: the rule upsert leans on
 * an expression index ON CONFLICT cannot name, and grant deletion leans on
 * a MATCH SIMPLE composite FK — both behaviors a mocked chain would just
 * restate rather than verify.
 */

import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '@renkei/db';
import {
  ACL_CACHE_TTL_MS,
  clearFileShareCache,
  createShare,
  deleteGrant,
  deleteRule,
  deleteShare,
  getAclContext,
  getShare,
  hasAnyGrant,
  listGrantedShares,
  listGrants,
  listRules,
  upsertGrant,
  upsertRule,
} from './store';
import type { ShareInput } from './store';

const url = process.env.FILESHARE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeLive = url ? describe : describe.skip;

const SUBJECT = 'itest-subject';

function shareInput(name: string): ShareInput {
  return {
    name,
    protocol: 'sftp',
    host: 'files.example.test',
    port: null,
    shareName: null,
    rootPath: '/srv/data',
    caseInsensitive: false,
    maxAccess: 'read_write',
    enabled: true,
  };
}

describeLive('file-share store (live database)', () => {
  let db: Kysely<DB>;
  let tenantId: string;

  beforeAll(async () => {
    db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
    });
    const tenant = await db
      .insertInto('tenants')
      .values({ id: randomUUID(), slug: `fs-itest-${Date.now()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await db.destroy();
  });

  beforeEach(() => clearFileShareCache());

  it('creates, reads, updates and deletes a share', async () => {
    const created = await createShare(db, tenantId, shareInput('crud'), 'sealed-credential');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const fetched = await getShare(db, tenantId, created.val);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.val?.summary.name).toBe('crud');
      expect(fetched.val?.summary.hasCredentials).toBe(true);
    }

    const duplicate = await createShare(db, tenantId, shareInput('crud'), null);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.err.type).toBe('DUPLICATE_NAME');

    const deleted = await deleteShare(db, tenantId, created.val);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.val).toBe(true);
  });

  it('grants gate discovery and availability', async () => {
    const created = await createShare(db, tenantId, shareInput('discovery'), 'cred');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;

    const before = await hasAnyGrant(db, tenantId, SUBJECT);
    expect(before.ok && before.val).toBe(false);

    const noContext = await getAclContext(db, tenantId, shareId, SUBJECT);
    expect(noContext.ok).toBe(true);
    if (noContext.ok) expect(noContext.val).toBeNull();

    await upsertGrant(db, tenantId, shareId, SUBJECT, 'read', 'admin-subject');

    const after = await hasAnyGrant(db, tenantId, SUBJECT);
    expect(after.ok && after.val).toBe(true);

    const granted = await listGrantedShares(db, tenantId, SUBJECT);
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      expect(granted.val).toHaveLength(1);
      expect(granted.val[0]?.grant.defaultAccess).toBe('read');
      expect(granted.val[0]?.hasRules).toBe(false);
    }

    await deleteShare(db, tenantId, shareId);
  });

  it('splits rule layers, upserts against the expression index, cascades on revoke', async () => {
    const created = await createShare(db, tenantId, shareInput('rules'), 'cred');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;
    await upsertGrant(db, tenantId, shareId, SUBJECT, 'read_write', 'admin-subject');

    // One rule per layer at the same path; the layers must not collide.
    await upsertRule(db, tenantId, shareId, null, '/finance', 'none', 'admin-subject');
    await upsertRule(db, tenantId, shareId, SUBJECT, '/finance', 'read', 'admin-subject');

    // Upsert on the same (layer, path) must update, not duplicate.
    await upsertRule(db, tenantId, shareId, null, '/finance', 'read', 'admin-subject');
    const shareLayer = await listRules(db, tenantId, shareId, null);
    expect(shareLayer.ok).toBe(true);
    if (shareLayer.ok) {
      expect(shareLayer.val).toHaveLength(1);
      expect(shareLayer.val[0]?.access).toBe('read');
    }

    clearFileShareCache();
    const context = await getAclContext(db, tenantId, shareId, SUBJECT);
    expect(context.ok).toBe(true);
    if (context.ok && context.val) {
      expect(context.val.shareRules).toEqual([{ path: '/finance', access: 'read' }]);
      expect(context.val.userRules).toEqual([{ path: '/finance', access: 'read' }]);
    }

    // Revoking the grant must cascade the user layer and leave the share layer.
    await deleteGrant(db, tenantId, shareId, SUBJECT);
    const userLayer = await listRules(db, tenantId, shareId, SUBJECT);
    const shareLayerAfter = await listRules(db, tenantId, shareId, null);
    expect(userLayer.ok && userLayer.val.length).toBe(0);
    expect(shareLayerAfter.ok && shareLayerAfter.val.length).toBe(1);

    const grants = await listGrants(db, tenantId, shareId);
    expect(grants.ok && grants.val.length).toBe(0);

    await deleteShare(db, tenantId, shareId);
  });

  it('serves the ACL context from cache within the TTL and clears on demand', async () => {
    const created = await createShare(db, tenantId, shareInput('cache'), 'cred');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;
    await upsertGrant(db, tenantId, shareId, SUBJECT, 'read', 'admin-subject');

    const first = await getAclContext(db, tenantId, shareId, SUBJECT);
    expect(first.ok).toBe(true);

    // A direct DB write (no cache clear) must NOT show up within the TTL…
    await db
      .updateTable('file_share_grants')
      .set({ default_access: 'read_write' })
      .where('share_id', '=', shareId)
      .where('subject', '=', SUBJECT)
      .execute();
    const stale = await getAclContext(db, tenantId, shareId, SUBJECT);
    expect(stale.ok && stale.val?.grant.defaultAccess).toBe('read');
    expect(ACL_CACHE_TTL_MS).toBeGreaterThan(0);

    // …and must show up the moment the cache is dropped.
    clearFileShareCache();
    const fresh = await getAclContext(db, tenantId, shareId, SUBJECT);
    expect(fresh.ok && fresh.val?.grant.defaultAccess).toBe('read_write');

    await deleteShare(db, tenantId, shareId);
  });

  it('lets a rule delete round-trip', async () => {
    const created = await createShare(db, tenantId, shareInput('rule-del'), 'cred');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;
    await upsertGrant(db, tenantId, shareId, SUBJECT, 'read', 'admin-subject');
    await upsertRule(db, tenantId, shareId, SUBJECT, '/x', 'none', 'admin-subject');

    const rules = await listRules(db, tenantId, shareId, SUBJECT);
    expect(rules.ok).toBe(true);
    if (!rules.ok || rules.val.length !== 1) return;

    const removed = await deleteRule(db, tenantId, shareId, rules.val[0].id);
    expect(removed.ok && removed.val).toBe(true);
    await deleteShare(db, tenantId, shareId);
  });
});
