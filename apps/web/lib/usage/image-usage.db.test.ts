/**
 * The image ledger, end to end from `recordImageUsage` to the readers: one
 * row per picture is written content-free and attributed to a person;
 * totals read back org-wide or for one person within a span; the per-user
 * rows carry names for the leaderboard; and a row outside the span is not
 * counted.
 *
 * Against a fresh memory store, so the organization-wide totals are this
 * suite's alone (the differential suite holds the store's aggregation to
 * Postgres's). The picture from long ago is recorded the app's way, with
 * the clock set back while it is written.
 */

import { randomUUID } from 'node:crypto';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { recordImageUsage } from '@/lib/image/usage';
import { getImageTotals, getImageUsers } from './image-usage';
import { getOrgDailySeries, getSurfaceTokenTotals } from './org-usage';

/** Only `Date` is faked: promises, timers and the rest stay real. */
const ONLY_DATE = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

describe('image usage ledger', () => {
  let store: MemoryDataStore;
  const runId = randomUUID();
  const ann = `ann-${runId.slice(0, 8)}`;
  const bo = `bo-${runId.slice(0, 8)}`;
  const span = { days: 7, endOffsetDays: 0 };

  beforeAll(async () => {
    store = createMemoryDataStore();
    registerDataStore(store);
    await store.identities.upsert({
      subject: ann,
      displayName: 'Ann Example',
      email: 'ann@example.test',
      idpGroups: [],
    });

    const base = { surface: 'images', provider: 'openai', model: 'gpt-image-1' };
    await recordImageUsage({
      ...base,
      subject: ann,
      imageBytes: 3_000_000,
      width: 1024,
      height: 1024,
      inputTokens: 61,
      outputTokens: 4160,
    });
    await recordImageUsage({
      ...base,
      subject: ann,
      imageBytes: 1_000_000,
      width: 1536,
      height: 1024,
      inputTokens: 40,
      outputTokens: 1000,
    });
    await recordImageUsage({
      surface: 'flux',
      provider: 'openai',
      model: 'FLUX.2-flex',
      subject: bo,
      imageBytes: 500_000,
      width: 1024,
      height: 1024,
    });
    // A picture from long ago (60 days back) is outside the span.
    jest.useFakeTimers({ now: Date.now() - 60 * 86_400_000, doNotFake: [...ONLY_DATE] });
    try {
      await recordImageUsage({ ...base, subject: ann, imageBytes: 7_000_000 });
    } finally {
      jest.useRealTimers();
    }
  });

  afterAll(() => {
    resetDataStore();
  });

  it('stores one content-free row per picture', async () => {
    // Nothing of the prompt or the picture is a column at all.
    expect(Object.keys(store.tables.columnsOf('image_usage')).sort()).toEqual(
      [
        'created_at',
        'height',
        'id',
        'image_bytes',
        'images',
        'input_tokens',
        'model',
        'output_tokens',
        'provider',
        'subject',
        'surface',
        'width',
      ].sort()
    );
    // Bo's one FLUX picture is one row: one image, its size, no tokens.
    expect(await getImageTotals(span, 'UTC', bo)).toEqual({
      images: 1,
      bytes: 500_000,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('totals the org over the span, leaving out old pictures', async () => {
    const totals = await getImageTotals(span, 'UTC');
    expect(totals).toEqual({ images: 3, bytes: 4_500_000, inputTokens: 101, outputTokens: 5160 });
  });

  it('totals one person on their own', async () => {
    expect(await getImageTotals(span, 'UTC', ann)).toEqual({
      images: 2,
      bytes: 4_000_000,
      inputTokens: 101,
      outputTokens: 5160,
    });
    expect(await getImageTotals(span, 'UTC', bo)).toEqual({
      images: 1,
      bytes: 500_000,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(await getImageTotals(span, 'UTC', 'nobody')).toEqual({
      images: 0,
      bytes: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('puts image tokens, pictures and bytes in the org series by the hour and the day', async () => {
    const hourly = await getOrgDailySeries(span, 'UTC', null, 'hour');
    const images = hourly.filter((row) => row.images > 0);
    // Every picture was drawn in the current hour.
    expect(images).toHaveLength(1);
    // (The chat and agent columns are the whole organization's, so other
    // suites' rows in a shared database can land there; they are not judged.)
    expect(images[0]).toMatchObject({
      images: 3,
      imageBytes: 4_500_000,
      imageInputTokens: 101,
      imageOutputTokens: 5160,
    });
    expect(images[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);

    const daily = await getOrgDailySeries(span, 'UTC', null, 'day');
    expect(daily.find((row) => row.images > 0)).toMatchObject({ images: 3, imageBytes: 4_500_000 });

    // One person: Ann's two pictures, none of Bo's FLUX picture.
    const mine = await getOrgDailySeries(span, 'UTC', ann, 'day');
    expect(mine.find((row) => row.images > 0)).toMatchObject({
      images: 2,
      imageBytes: 4_000_000,
      imageInputTokens: 101,
    });
    // The old picture (60 days back) is outside a week.
    expect(daily.reduce((sum, row) => sum + row.imageBytes, 0)).toBe(4_500_000);
  });

  it('counts the tokens image models billed as their own surface, beside chat and agents', async () => {
    const org = await getSurfaceTokenTotals(span, 'UTC');
    expect(org.images).toEqual({ input: 101, output: 5160 });
    // (The chat and agent surfaces are the whole organization's, so other
    // suites' rows in a shared database can land there; they are not judged.)
    // Scoped to a person: Ann's own, and FLUX (which bills no tokens) adds none for Bo.
    expect((await getSurfaceTokenTotals(span, 'UTC', ann)).images).toEqual({
      input: 101,
      output: 5160,
    });
    expect((await getSurfaceTokenTotals(span, 'UTC', bo)).images).toEqual({
      input: 0,
      output: 0,
    });
    // The picture from 60 days ago carries no tokens, and a wider span still leaves them as they are.
    expect((await getSurfaceTokenTotals({ days: 90, endOffsetDays: 0 }, 'UTC')).images).toEqual({
      input: 101,
      output: 5160,
    });
  });

  it('reads a wider span back to include the old picture', async () => {
    const wide = await getImageTotals({ days: 90, endOffsetDays: 0 }, 'UTC');
    expect(wide.images).toBe(4);
    expect(wide.bytes).toBe(11_500_000);
  });

  it('lists everyone with images, named where the org knows them', async () => {
    const users = await getImageUsers(span, 'UTC');
    const bySubject = new Map(users.map((u) => [u.subject, u]));
    expect(bySubject.get(ann)).toMatchObject({
      label: 'Ann Example',
      images: 2,
      bytes: 4_000_000,
      inputTokens: 101,
      outputTokens: 5160,
    });
    // Someone with no identity row is named by their subject.
    expect(bySubject.get(bo)).toMatchObject({ label: bo, images: 1, bytes: 500_000 });
    expect(users).toHaveLength(2);
  });

  it('never throws when a row cannot be written', async () => {
    // A write the store refuses; the picture must still reach the person.
    const refused = jest
      .spyOn(store.usage, 'recordImage')
      .mockRejectedValueOnce(new Error('value out of range'));
    await expect(
      recordImageUsage({
        surface: 'images',
        provider: 'openai',
        model: 'm',
        subject: ann,
        imageBytes: Number.NaN,
      })
    ).resolves.toBeUndefined();
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
