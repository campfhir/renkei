/**
 * The staged-file store over a registered memory data store (the
 * differential suite holds the store's two implementations to each
 * other): a file is listed, read and deleted only from the scope it was
 * staged in (migration 169), a batch's files by their batch from any
 * scope, and the quota counts the subject's files across every scope.
 */

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import * as store from './store';

describe('sandbox file store scopes', () => {
  const subject = `store-test-${randomUUID()}`;
  const chatA = { subject, scope: `chat:${randomUUID()}` };
  const chatB = { subject, scope: `chat:${randomUUID()}` };
  const project = { subject, scope: `project:${randomUUID()}` };
  const personal = { subject };

  beforeAll(() => {
    registerDataStore(createMemoryDataStore());
  });

  afterAll(() => {
    resetDataStore();
  });

  const stage = (target: store.SandboxTarget, filename: string, batchId: string | null = null) =>
    store.insertFile({
      ...target,
      filename,
      contentType: 'text/plain',
      sizeBytes: 10,
      storageKey: `key-${filename}`,
      source: 'chat',
      batchId,
      expiresAt: new Date(Date.now() + 60_000),
    });

  it('keeps one chat’s files out of another’s, a project’s and the personal space', async () => {
    const file = await stage(chatA, 'a.txt');
    await stage(project, 'p.txt');

    expect((await store.listFiles(chatA)).map((f) => f.filename)).toEqual(['a.txt']);
    expect(await store.listFiles(chatB)).toEqual([]);
    expect(await store.listFiles(personal)).toEqual([]);
    expect((await store.listFiles(project)).map((f) => f.filename)).toEqual(['p.txt']);

    expect(await store.getFile(chatB, file.id)).toBeUndefined();
    expect(await store.getFile(project, file.id)).toBeUndefined();
    expect(await store.deleteFile(chatB, file.id)).toBeUndefined();
    expect((await store.getFile(chatA, file.id))?.filename).toBe('a.txt');

    // The quota is the person's, whichever scope staged the file.
    expect(await store.countFiles(chatB)).toBe(2);
  });

  it('reaches a batch’s files by its batch from any scope', async () => {
    const batchId = randomUUID();
    const page = await stage(personal, 'page-1.png', batchId);
    expect((await store.listFiles(chatB, batchId)).map((f) => f.id)).toEqual([page.id]);
    expect(await store.listFiles(chatB)).toEqual([]);
    expect((await store.getFile(chatB, page.id))?.id).toBe(page.id);
  });
});
