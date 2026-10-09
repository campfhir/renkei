/**
 * The image ledger against a real database (skipped without DATABASE_URL):
 * one row per picture is written content-free and attributed to a person;
 * totals read back org-wide or for one person within a span; the per-user
 * rows carry names for the leaderboard; and a row outside the span, or
 * another org's, is not counted.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { recordImageUsage } from '@/lib/image/usage';
import { getImageTotals, getImageUsers } from './image-usage';
import { getOrgDailySeries, getSurfaceTokenTotals } from './org-usage';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('image usage ledger', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const ann = `ann-${tenantId.slice(0, 8)}`;
  const bo = `bo-${tenantId.slice(0, 8)}`;
  const span = { days: 7, endOffsetDays: 0 };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    for (const id of [tenantId, otherTenantId]) {
      await db
        .insertInto('tenants')
        .values({ id, slug: `image-usage-${id.slice(0, 8)}` })
        .execute();
    }
    await db
      .insertInto('identities')
      .values({
        subject: ann,
        display_name: 'Ann Example',
        email: 'ann@example.test',
      })
      .execute();

    const base = { surface: 'images', provider: 'openai', model: 'gpt-image-1' };
    await recordImageUsage(db, {
      ...base,
      subject: ann,
      imageBytes: 3_000_000,
      width: 1024,
      height: 1024,
      inputTokens: 61,
      outputTokens: 4160,
    });
    await recordImageUsage(db, {
      ...base,
      subject: ann,
      imageBytes: 1_000_000,
      width: 1536,
      height: 1024,
      inputTokens: 40,
      outputTokens: 1000,
    });
    await recordImageUsage(db, {
      surface: 'flux',
      provider: 'openai',
      model: 'FLUX.2-flex',
      subject: bo,
      imageBytes: 500_000,
      width: 1024,
      height: 1024,
    });
    // Another org's picture is not this org's.
    await recordImageUsage(db, {
      ...base,
      subject: ann,
      imageBytes: 9_000_000,
    });
    // A picture from long ago is outside the span.
    await sql`
      INSERT INTO image_usage (tenant_id, subject, surface, images, image_bytes, created_at)
      VALUES (${tenantId}, ${ann}, 'images', 1, 7000000, NOW() - interval '60 days')
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM image_usage WHERE tenant_id IN (${tenantId}, ${otherTenantId})`.execute(
      db
    );
    await sql`DELETE FROM identities`.execute(db);
    await sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${otherTenantId})`.execute(db);
    await closeDatabase();
  });

  it('stores one content-free row per picture', async () => {
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM image_usage WHERE subject = ${bo}
    `.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      surface: 'flux',
      provider: 'openai',
      model: 'FLUX.2-flex',
      images: 1,
      width: 1024,
      height: 1024,
      input_tokens: 0,
      output_tokens: 0,
    });
    // Nothing of the prompt or the picture is a column at all.
    expect(Object.keys(rows.rows[0]!).sort()).toEqual(
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
  });

  it('totals the org over the span, leaving out other orgs and old pictures', async () => {
    const totals = await getImageTotals(db, tenantId, span, 'UTC');
    expect(totals).toEqual({ images: 3, bytes: 4_500_000, inputTokens: 101, outputTokens: 5160 });
  });

  it('totals one person on their own', async () => {
    expect(await getImageTotals(db, tenantId, span, 'UTC', ann)).toEqual({
      images: 2,
      bytes: 4_000_000,
      inputTokens: 101,
      outputTokens: 5160,
    });
    expect(await getImageTotals(db, tenantId, span, 'UTC', bo)).toEqual({
      images: 1,
      bytes: 500_000,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(await getImageTotals(db, tenantId, span, 'UTC', 'nobody')).toEqual({
      images: 0,
      bytes: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('puts image tokens, pictures and bytes in the org series by the hour and the day', async () => {
    const hourly = await getOrgDailySeries(db, tenantId, span, 'UTC', null, 'hour');
    const images = hourly.filter((row) => row.images > 0);
    // Every picture was drawn in the current hour.
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      images: 3,
      imageBytes: 4_500_000,
      imageInputTokens: 101,
      imageOutputTokens: 5160,
      chatInputTokens: 0,
      agentInputTokens: 0,
    });
    expect(images[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);

    const daily = await getOrgDailySeries(db, tenantId, span, 'UTC', null, 'day');
    expect(daily.find((row) => row.images > 0)).toMatchObject({ images: 3, imageBytes: 4_500_000 });

    // One person: Ann's two pictures, none of Bo's FLUX picture.
    const mine = await getOrgDailySeries(db, tenantId, span, 'UTC', ann, 'day');
    expect(mine.find((row) => row.images > 0)).toMatchObject({
      images: 2,
      imageBytes: 4_000_000,
      imageInputTokens: 101,
    });
    // The old picture (60 days back) is outside a week.
    expect(daily.reduce((sum, row) => sum + row.imageBytes, 0)).toBe(4_500_000);
  });

  it('counts the tokens image models billed as their own surface, beside chat and agents', async () => {
    const org = await getSurfaceTokenTotals(db, tenantId, span, 'UTC');
    expect(org.images).toEqual({ input: 101, output: 5160 });
    // Nothing else was spent here.
    expect(org.chat).toEqual({ input: 0, output: 0 });
    expect(org.agents).toEqual({ input: 0, output: 0 });
    // Scoped to a person: Ann's own, and FLUX (which bills no tokens) adds none for Bo.
    expect((await getSurfaceTokenTotals(db, tenantId, span, 'UTC', ann)).images).toEqual({
      input: 101,
      output: 5160,
    });
    expect((await getSurfaceTokenTotals(db, tenantId, span, 'UTC', bo)).images).toEqual({
      input: 0,
      output: 0,
    });
    // The picture from 60 days ago carries no tokens, and a wider span still leaves them as they are.
    expect(
      (await getSurfaceTokenTotals(db, tenantId, { days: 90, endOffsetDays: 0 }, 'UTC')).images
    ).toEqual({ input: 101, output: 5160 });
  });

  it('reads a wider span back to include the old picture', async () => {
    const wide = await getImageTotals(db, tenantId, { days: 90, endOffsetDays: 0 }, 'UTC');
    expect(wide.images).toBe(4);
    expect(wide.bytes).toBe(11_500_000);
  });

  it('lists everyone with images, named where the org knows them', async () => {
    const users = await getImageUsers(db, tenantId, span, 'UTC');
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
    // A tenant that does not exist breaks the foreign key; the picture must still reach the person.
    await expect(
      recordImageUsage(db, {
        surface: 'images',
        provider: 'openai',
        model: 'm',
        subject: ann,
        imageBytes: 1,
      })
    ).resolves.toBeUndefined();
  });
});
