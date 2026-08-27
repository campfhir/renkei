/**
 * Store round-trip against a real Postgres with the migrated schema —
 * FILESHARE_TEST_DATABASE_URL (or DATABASE_URL) points at it; without one
 * the suite skips itself. Live SQL is the point: the connection upsert
 * leans on a named PK constraint for ON CONFLICT, and share deletion leans
 * on the connections FK cascade — behaviors a mocked chain would just
 * restate rather than verify.
 */

import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '@renkei/db';
import {
  createShare,
  deleteConnection,
  deleteShare,
  getConnection,
  getShare,
  listConnectedShares,
  listShares,
  listSharesWithConnection,
  readConnectionCiphertext,
  resolveToolExposure,
  updateConnectionExposure,
  updateShare,
  upsertConnection,
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
    enabled: true,
  };
}

function connectionInput(username = 'alice') {
  return {
    encryptedCredentials: `sealed-${username}`,
    username,
    toolAccess: 'read' as const,
    allowDelete: false,
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

  it('round-trips a share through create, update, list and get', async () => {
    const created = await createShare(db, tenantId, shareInput('Finance'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;

    const listed = await listShares(db, tenantId);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.val.map((row) => row.summary.name)).toContain('Finance');
    }

    const updated = await updateShare(db, tenantId, shareId, {
      ...shareInput('Finance'),
      host: 'nas2.example.test',
      enabled: false,
    });
    expect(updated).toMatchObject({ ok: true, val: true });

    const fetched = await getShare(db, tenantId, shareId);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.val?.summary.host).toBe('nas2.example.test');
      expect(fetched.val?.summary.enabled).toBe(false);
    }

    const removed = await deleteShare(db, tenantId, shareId);
    expect(removed).toMatchObject({ ok: true, val: true });
  });

  it('rejects a duplicate share name per tenant', async () => {
    const first = await createShare(db, tenantId, shareInput('Dupe'));
    expect(first.ok).toBe(true);
    const second = await createShare(db, tenantId, shareInput('Dupe'));
    expect(second).toMatchObject({ ok: false, err: { type: 'DUPLICATE_NAME' } });
    if (first.ok) await deleteShare(db, tenantId, first.val);
  });

  it('round-trips a connection and updates exposure in place', async () => {
    const created = await createShare(db, tenantId, shareInput('Engineering'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;

    const stored = await upsertConnection(db, tenantId, shareId, SUBJECT, connectionInput());
    expect(stored.ok).toBe(true);

    const connection = await getConnection(db, tenantId, shareId, SUBJECT);
    expect(connection).toMatchObject({
      ok: true,
      val: { username: 'alice', toolAccess: 'read', allowDelete: false },
    });

    const ciphertext = await readConnectionCiphertext(db, tenantId, shareId, SUBJECT);
    expect(ciphertext).toMatchObject({ ok: true, val: 'sealed-alice' });

    // Re-upsert replaces the credential and choice in one statement.
    const replaced = await upsertConnection(db, tenantId, shareId, SUBJECT, {
      ...connectionInput('alice2'),
      toolAccess: 'read_write',
    });
    expect(replaced.ok).toBe(true);
    const after = await getConnection(db, tenantId, shareId, SUBJECT);
    expect(after).toMatchObject({
      ok: true,
      val: { username: 'alice2', toolAccess: 'read_write' },
    });

    const exposureOnly = await updateConnectionExposure(
      db,
      tenantId,
      shareId,
      SUBJECT,
      'read_write',
      true
    );
    expect(exposureOnly).toMatchObject({ ok: true, val: true });
    const kept = await readConnectionCiphertext(db, tenantId, shareId, SUBJECT);
    expect(kept).toMatchObject({ ok: true, val: 'sealed-alice2' });

    const gone = await deleteConnection(db, tenantId, shareId, SUBJECT);
    expect(gone).toMatchObject({ ok: true, val: true });
    const missing = await getConnection(db, tenantId, shareId, SUBJECT);
    expect(missing).toMatchObject({ ok: true, val: null });

    await deleteShare(db, tenantId, shareId);
  });

  it('lists all enabled shares with this subject connection-marked', async () => {
    const a = await createShare(db, tenantId, shareInput('Alpha'));
    const b = await createShare(db, tenantId, shareInput('Beta'));
    const off = await createShare(db, tenantId, { ...shareInput('Gamma'), enabled: false });
    expect(a.ok && b.ok && off.ok).toBe(true);
    if (!a.ok || !b.ok || !off.ok) return;

    await upsertConnection(db, tenantId, a.val, SUBJECT, {
      ...connectionInput(),
      toolAccess: 'read_write',
      allowDelete: true,
    });

    const withConnection = await listSharesWithConnection(db, tenantId, SUBJECT);
    expect(withConnection.ok).toBe(true);
    if (withConnection.ok) {
      const names = withConnection.val.map((entry) => entry.share.name);
      expect(names).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
      expect(names).not.toContain('Gamma');
      const alpha = withConnection.val.find((entry) => entry.share.name === 'Alpha');
      const beta = withConnection.val.find((entry) => entry.share.name === 'Beta');
      expect(alpha?.connection).toMatchObject({ toolAccess: 'read_write', allowDelete: true });
      expect(beta?.connection).toBeNull();
    }

    const connected = await listConnectedShares(db, tenantId, SUBJECT);
    expect(connected.ok).toBe(true);
    if (connected.ok) {
      expect(connected.val.map((entry) => entry.share.name)).toEqual(['Alpha']);
    }

    const exposure = await resolveToolExposure(db, tenantId, SUBJECT);
    expect(exposure).toMatchObject({ ok: true, val: { read: true, write: true, del: true } });

    // A disabled share's connection stops counting toward exposure.
    await updateShare(db, tenantId, a.val, { ...shareInput('Alpha'), enabled: false });
    const afterDisable = await resolveToolExposure(db, tenantId, SUBJECT);
    expect(afterDisable).toMatchObject({
      ok: true,
      val: { read: false, write: false, del: false },
    });

    for (const id of [a.val, b.val, off.val]) await deleteShare(db, tenantId, id);
  });

  it('share deletion cascades to its connections', async () => {
    const created = await createShare(db, tenantId, shareInput('Doomed'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await upsertConnection(db, tenantId, created.val, SUBJECT, connectionInput());

    await deleteShare(db, tenantId, created.val);
    const orphan = await db
      .selectFrom('file_share_connections')
      .select('share_id')
      .where('tenant_id', '=', tenantId)
      .where('share_id', '=', created.val)
      .executeTakeFirst();
    expect(orphan).toBeUndefined();
  });
});
