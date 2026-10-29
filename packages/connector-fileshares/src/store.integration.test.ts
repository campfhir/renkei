import { closeDataStore } from '@renkei/db';
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

const describeLive = process.env.DATABASE_URL ? describe : describe.skip;

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
    hostKeyFingerprint: null,
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
  afterAll(async () => {
    await closeDataStore();
  });

  it('round-trips a share through create, update, list and get', async () => {
    const created = await createShare(shareInput('Finance'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;

    const listed = await listShares();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.val.map((row) => row.summary.name)).toContain('Finance');
    }

    const updated = await updateShare(shareId, {
      ...shareInput('Finance'),
      host: 'nas2.example.test',
      enabled: false,
    });
    expect(updated).toMatchObject({ ok: true, val: true });

    const fetched = await getShare(shareId);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.val?.summary.host).toBe('nas2.example.test');
      expect(fetched.val?.summary.enabled).toBe(false);
    }

    const removed = await deleteShare(shareId);
    expect(removed).toMatchObject({ ok: true, val: true });
  });

  it('rejects a duplicate share name per tenant', async () => {
    const first = await createShare(shareInput('Dupe'));
    expect(first.ok).toBe(true);
    const second = await createShare(shareInput('Dupe'));
    expect(second).toMatchObject({ ok: false, err: { type: 'DUPLICATE_NAME' } });
    if (first.ok) await deleteShare(first.val);
  });

  it('round-trips a connection and updates exposure in place', async () => {
    const created = await createShare(shareInput('Engineering'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shareId = created.val;

    const stored = await upsertConnection(shareId, SUBJECT, connectionInput());
    expect(stored.ok).toBe(true);

    const connection = await getConnection(shareId, SUBJECT);
    expect(connection).toMatchObject({
      ok: true,
      val: { username: 'alice', toolAccess: 'read', allowDelete: false },
    });

    const ciphertext = await readConnectionCiphertext(shareId, SUBJECT);
    expect(ciphertext).toMatchObject({ ok: true, val: 'sealed-alice' });

    // Re-upsert replaces the credential and choice in one statement.
    const replaced = await upsertConnection(shareId, SUBJECT, {
      ...connectionInput('alice2'),
      toolAccess: 'read_write',
    });
    expect(replaced.ok).toBe(true);
    const after = await getConnection(shareId, SUBJECT);
    expect(after).toMatchObject({
      ok: true,
      val: { username: 'alice2', toolAccess: 'read_write' },
    });

    const exposureOnly = await updateConnectionExposure(shareId, SUBJECT, 'read_write', true);
    expect(exposureOnly).toMatchObject({ ok: true, val: true });
    const kept = await readConnectionCiphertext(shareId, SUBJECT);
    expect(kept).toMatchObject({ ok: true, val: 'sealed-alice2' });

    const gone = await deleteConnection(shareId, SUBJECT);
    expect(gone).toMatchObject({ ok: true, val: true });
    const missing = await getConnection(shareId, SUBJECT);
    expect(missing).toMatchObject({ ok: true, val: null });

    await deleteShare(shareId);
  });

  it('lists all enabled shares with this subject connection-marked', async () => {
    const a = await createShare(shareInput('Alpha'));
    const b = await createShare(shareInput('Beta'));
    const off = await createShare({ ...shareInput('Gamma'), enabled: false });
    expect(a.ok && b.ok && off.ok).toBe(true);
    if (!a.ok || !b.ok || !off.ok) return;

    await upsertConnection(a.val, SUBJECT, {
      ...connectionInput(),
      toolAccess: 'read_write',
      allowDelete: true,
    });

    const withConnection = await listSharesWithConnection(SUBJECT);
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

    const connected = await listConnectedShares(SUBJECT);
    expect(connected.ok).toBe(true);
    if (connected.ok) {
      expect(connected.val.map((entry) => entry.share.name)).toEqual(['Alpha']);
    }

    const exposure = await resolveToolExposure(SUBJECT);
    expect(exposure).toMatchObject({ ok: true, val: { read: true, write: true, del: true } });

    // A disabled share's connection stops counting toward exposure.
    await updateShare(a.val, { ...shareInput('Alpha'), enabled: false });
    const afterDisable = await resolveToolExposure(SUBJECT);
    expect(afterDisable).toMatchObject({
      ok: true,
      val: { read: false, write: false, del: false },
    });

    for (const id of [a.val, b.val, off.val]) await deleteShare(id);
  });

  it('share deletion cascades to its connections', async () => {
    const created = await createShare(shareInput('Doomed'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await upsertConnection(created.val, SUBJECT, connectionInput());

    expect(await getConnection(created.val, SUBJECT)).toMatchObject({
      ok: true,
      val: { username: 'alice' },
    });

    await deleteShare(created.val);
    expect(await getConnection(created.val, SUBJECT)).toEqual({ ok: true, val: null });
    expect(await readConnectionCiphertext(created.val, SUBJECT)).toMatchObject({
      ok: true,
      val: null,
    });
  });
});
