/**
 * Image generation, end to end in a browser, from seeded rows alone — no
 * image vendor and no model is called:
 *
 *   - a picture the model drew (chat_generate_image) is shown INLINE in the
 *     call that drew it, outside the tool-call fold, with its own icon, and a
 *     call that failed shows its reason instead;
 *   - a call still waiting is an outline in the SHAPE the model asked for
 *     (the aspect ratio of `size`, or of `aspectRatio`), at a phone's width
 *     too;
 *   - Preferences offers the org's image models and saves the person's pick,
 *     and leaves the section out when the org has none;
 *   - My usage and Organization usage count the pictures: how many, how much
 *     space in KB/MB/GB, the tokens billed, and who has the most.
 *
 * The image bytes are not in a blob store here, so the browser's request for
 * the stored file is answered by `page.route`. Its own tenant, derived from
 * the project name (the way llm-models.spec.ts does it): the empty-state
 * assertions need the org to genuinely have no image model.
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport (see
 * AGENTS.md's "UI changes" section).
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** The first hit on a route compiles it (`next dev` builds lazily). */
const COLD = { timeout: 30_000 };

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(projectName: string) {
  const id = (what: string) => uuidFrom(`image-generation-e2e:${what}:${projectName}`);
  return {
    tenantId: id('tenant'),
    sessionId: id('session'),
    slug: `e2e-image-generation-${projectName}`,
    subject: `e2e-image-${projectName}@example.com`,
    otherSubject: `e2e-image-other-${projectName}@example.com`,
    chatModelId: id('chat-model'),
    painterId: id('painter'),
    foxId: id('fox'),
    doneChatId: id('done-chat'),
    doneTurnId: id('done-turn'),
    waitingChatId: id('waiting-chat'),
    waitingTurnId: id('waiting-turn'),
    attachmentId: id('attachment'),
    drawCall: `toolu_draw_${projectName}`,
    refusedCall: `toolu_refused_${projectName}`,
    waitingCall: `toolu_waiting_${projectName}`,
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

function secretbox(plaintext: string, encoded: string): string {
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}
const seal = (plaintext: string) =>
  'renc1:' +
  secretbox(
    plaintext,
    process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || ''
  );
const sealSecret = (plaintext: string) =>
  secretbox(plaintext, process.env.TOKEN_ENCRYPTION_KEY ?? '');

/** A real w×h PNG of one colour — what the browser is handed in place of the stored file. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill([r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PROMPT = 'generate a picture of a cute polarbear';

async function seedTenant(f: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const table of [
      'image_usage',
      'chat_attachments',
      'chats',
      'llm_model_configs',
      'user_preferences',
      'sessions',
      'identities',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [f.tenantId]);
    }
    await client.query('DELETE FROM tenants WHERE id = $1', [f.tenantId]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [f.tenantId, f.slug]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        f.sessionId,
        f.tenantId,
        f.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    for (const [subject, name] of [
      [f.subject, 'E2E Tester'],
      [f.otherSubject, 'Another Person'],
    ]) {
      await client.query(
        `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, $4)`,
        [f.tenantId, subject, subject, name]
      );
    }
    // No coach marks tour stealing focus mid-screenshot.
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [f.tenantId, f.subject]
    );
  } finally {
    await client.end();
  }
}

async function addModels(f: Fixture, which: ('chat' | 'painter' | 'fox')[]): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const secret = sealSecret(JSON.stringify({ apiKey: 'e2e' }));
    if (which.includes('chat')) {
      await client.query(
        `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
         VALUES ($1, $2, 'Chatty', 'anthropic', 'e2e-model', 'http://127.0.0.1:8092/anthropic', $3, true, false)`,
        [f.chatModelId, f.tenantId, secret]
      );
    }
    if (which.includes('painter')) {
      await client.query(
        `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, settings, enabled, is_default)
         VALUES ($1, $2, 'Painter', 'openai', 'gpt-image-1', $3, '{"apiSurface":"images"}'::jsonb, true, false)`,
        [f.painterId, f.tenantId, secret]
      );
    }
    if (which.includes('fox')) {
      await client.query(
        `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, settings, enabled, is_default)
         VALUES ($1, $2, 'Fox', 'openai', 'FLUX.2-flex', $3, '{"apiSurface":"flux","apiVersion":"preview"}'::jsonb, true, false)`,
        [f.foxId, f.tenantId, secret]
      );
    }
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, f: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session_${f.tenantId}`,
      value: f.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

interface Row {
  seq: number;
  role: 'user' | 'assistant';
  kind: 'prompt' | 'assistant' | 'tool_results';
  blocks: unknown[];
}

/** Inserts the rows; returns each row's id, by seq. */
async function seedRows(
  client: Client,
  f: Fixture,
  chatId: string,
  turnId: string,
  rows: Row[]
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    const inserted = await client.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11) RETURNING id`,
      [
        f.tenantId,
        chatId,
        turnId,
        row.seq,
        row.role,
        row.kind,
        seal(JSON.stringify(row.blocks)),
        assistant ? f.chatModelId : null,
        assistant ? 'anthropic' : null,
        assistant ? 'e2e-model' : null,
        assistant ? 'tool_use' : null,
      ]
    );
    ids.set(row.seq, inserted.rows[0].id);
  }
  return ids;
}

/** A finished chat: one picture drawn, one call the image model refused. */
async function seedDoneChat(f: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, 'Polar bear', $4, NOW())`,
      [f.doneChatId, f.tenantId, f.subject, f.chatModelId]
    );
    await client.query(
      `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, finished_at)
       VALUES ($1, $2, $3, 'completed', $4, 2, NOW())`,
      [f.doneTurnId, f.tenantId, f.doneChatId, f.chatModelId]
    );
    const ids = await seedRows(client, f, f.doneChatId, f.doneTurnId, [
      { seq: 1, role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: PROMPT }] },
      {
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        blocks: [
          { type: 'text', text: 'Here is your polar bear.' },
          {
            type: 'tool_use',
            id: f.drawCall,
            name: 'chat_generate_image',
            input: { filename: 'cute_polar_bear.png', size: '1536x1024', quality: 'high' },
          },
          {
            type: 'tool_use',
            id: f.refusedCall,
            name: 'chat_generate_image',
            input: { filename: 'second.png', aspectRatio: '1:1' },
          },
        ],
      },
      {
        seq: 3,
        role: 'user',
        kind: 'tool_results',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: f.drawCall,
            content:
              'Generated cute_polar_bear.png with Painter (image/png, 1536x1024 px, 2345 bytes). It is under this chat’s Artifacts.',
            durationMs: 41_000,
          },
          {
            type: 'tool_result',
            toolUseId: f.refusedCall,
            content:
              'The image model’s safety system refused this prompt or the picture it made. Tell the person, and offer to try a different description.',
            isError: true,
            durationMs: 3_000,
          },
        ],
      },
    ]);
    // The file the call kept, as the runner stores it: tied to the results row.
    await client.query(
      `INSERT INTO chat_attachments (id, tenant_id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, origin, message_id)
       VALUES ($1, $2, $3, $4, $5, 'cute_polar_bear.png', 'image/png', 2345, 'none', 'model', $6)`,
      [
        f.attachmentId,
        f.tenantId,
        f.subject,
        f.doneChatId,
        `chat/${f.tenantId}/${f.doneTurnId}`,
        ids.get(3),
      ]
    );
  } finally {
    await client.end();
  }
}

/**
 * A running turn on the image call. `parked`: it is waiting on the person's
 * permission ask (nothing is being drawn yet); otherwise it is approved and
 * the call is in flight.
 */
async function seedWaitingChat(
  f: Fixture,
  input: Record<string, unknown>,
  { parked }: { parked: boolean }
): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [f.waitingChatId]);
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, 'Waiting for a picture', $4, NOW())`,
      [f.waitingChatId, f.tenantId, f.subject, f.chatModelId]
    );
    const ask = {
      toolUseId: f.waitingCall,
      messageId: 'pending',
      name: 'chat_generate_image',
      requestedAt: new Date().toISOString(),
      decision: null,
      decidedAt: null,
    };
    await client.query(
      parked
        ? `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, stage, stage_at, tool_permission)
           VALUES ($1, $2, $3, 'running', $4, 1, 'permission:chat_generate_image', NOW(), $5::jsonb)`
        : `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, stage_at)
           VALUES ($1, $2, $3, 'running', $4, 1, NOW())`,
      parked
        ? [f.waitingTurnId, f.tenantId, f.waitingChatId, f.chatModelId, JSON.stringify(ask)]
        : [f.waitingTurnId, f.tenantId, f.waitingChatId, f.chatModelId]
    );
    const ids = await seedRows(client, f, f.waitingChatId, f.waitingTurnId, [
      { seq: 1, role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: PROMPT }] },
      {
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        blocks: [
          { type: 'text', text: 'Drawing it now.' },
          { type: 'tool_use', id: f.waitingCall, name: 'chat_generate_image', input },
        ],
      },
    ]);
    if (parked) {
      await client.query(
        `UPDATE chat_turns SET tool_permission = tool_permission || $2::jsonb WHERE id = $1`,
        [f.waitingTurnId, JSON.stringify({ messageId: ids.get(2) })]
      );
    }
  } finally {
    await client.end();
  }
}

async function seedUsage(f: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const row = `INSERT INTO image_usage (tenant_id, subject, surface, provider, model, images, image_bytes, width, height, input_tokens, output_tokens)
                 VALUES ($1, $2, $3, 'openai', $4, 1, $5, 1024, 1024, $6, $7)`;
    await client.query(row, [f.tenantId, f.subject, 'images', 'gpt-image-1', 3_000_000, 61, 4160]);
    await client.query(row, [f.tenantId, f.subject, 'images', 'gpt-image-1', 1_000_000, 40, 1000]);
    await client.query(row, [f.tenantId, f.otherSubject, 'flux', 'FLUX.2-flex', 500_000, 0, 0]);
  } finally {
    await client.end();
  }
}

let fixture: Fixture;

// eslint-disable-next-line no-empty-pattern -- Playwright reads fixtures off the first parameter's destructuring; this one needs none
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
});

test('a picture the model drew is shown inline in its call, with its own icon, and a refused call says why', async ({
  page,
}, testInfo) => {
  await addModels(fixture, ['chat', 'painter']);
  await seedDoneChat(fixture);
  // 3:2, like the size asked for; the bytes stand in for the blob store.
  const png = solidPng(150, 100, [120, 170, 230]);
  await page.route(
    `**/api/tenant/${fixture.tenantId}/chat/attachments/${fixture.attachmentId}`,
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png })
  );
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/chat/${fixture.doneChatId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Polar bear' })).toBeVisible();

  const cards = page.getByTestId('image-card');
  await expect(cards).toHaveCount(2, COLD);
  const drawn = cards.nth(0);
  await expect(drawn).toHaveAttribute('data-state', 'done');
  await expect(drawn).toContainText('Generated image');
  await expect(drawn).toContainText('41s');

  // The picture itself, loaded — the file this call kept, not the other's.
  const picture = drawn.getByRole('img', { name: 'cute_polar_bear.png' });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(150);
  await expect(drawn.getByTestId('image-card-picture')).toBeVisible();
  // It opens full size in a new tab.
  await expect(drawn.getByRole('link')).toHaveAttribute('target', '_blank');
  await expect(drawn.getByRole('link')).toHaveAttribute(
    'href',
    /\/chat\/attachments\/[0-9a-f-]{36}$/
  );

  // Inline, not folded away with the other tool calls; and the image glyph, not the wrench.
  await expect(drawn.locator('xpath=ancestor::details')).toHaveCount(0);
  await expect(drawn.locator('figcaption svg path').first()).toHaveAttribute('d', /^M4 5h16v14H4z/);

  // The call the image model refused: the reason, no picture.
  const refused = cards.nth(1);
  await expect(refused).toHaveAttribute('data-state', 'failed');
  await expect(refused).toContainText('Image could not be generated');
  await expect(refused.getByTestId('image-card-error')).toContainText('safety system refused');
  await expect(refused.getByRole('img')).toHaveCount(0);
  await shot(page, testInfo, 'image-card-done.png');

  // Phone width: the picture stays inside the thread.
  await page.setViewportSize(MOBILE_VIEWPORT);
  const box = await picture.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'image-card-done-mobile.png');
});

test('a call waiting on permission shows no outline; once approved it is an outline in the shape asked for', async ({
  page,
}, testInfo) => {
  await addModels(fixture, ['chat', 'painter']);
  await signIn(page, fixture);

  // Parked on the permission ask: nothing is being drawn, so no outline — only the caption.
  await seedWaitingChat(fixture, { filename: 'bear.png', size: '1024x1536' }, { parked: true });
  await page.goto(`/${fixture.slug}/chat/${fixture.waitingChatId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Waiting for a picture' })
  ).toBeVisible();
  const card = page.getByTestId('image-card');
  await expect(card).toBeVisible(COLD);
  await expect(card).toHaveAttribute('data-state', 'waiting');
  await expect(card).toContainText('Waiting for permission to generate an image');
  await expect(card.getByTestId('image-card-skeleton')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Permission needed' })).toBeVisible();
  await shot(page, testInfo, 'image-card-waiting-no-outline.png');

  // Approved and being drawn: portrait pixels, so width over height is 2/3.
  await seedWaitingChat(fixture, { filename: 'bear.png', size: '1024x1536' }, { parked: false });
  await page.reload();
  await expect(card).toHaveAttribute('data-state', 'pending', COLD);
  await expect(card).toContainText('Generating image');
  const skeleton = card.getByTestId('image-card-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(card).toHaveAttribute('data-ratio', '0.667');
  const portrait = await skeleton.boundingBox();
  expect(portrait!.width / portrait!.height).toBeCloseTo(2 / 3, 1);
  await shot(page, testInfo, 'image-card-generating-portrait.png');

  // A ratio instead of pixels: 16:9 landscape.
  await seedWaitingChat(fixture, { filename: 'bear.png', aspectRatio: '16:9' }, { parked: false });
  await page.reload();
  await expect(card).toHaveAttribute('data-ratio', /^1\.7/, COLD);
  const landscape = await card.getByTestId('image-card-skeleton').boundingBox();
  expect(landscape!.width / landscape!.height).toBeCloseTo(16 / 9, 1);

  // Nothing asked: a square.
  await seedWaitingChat(fixture, { filename: 'bear.png' }, { parked: false });
  await page.reload();
  await expect(card).toHaveAttribute('data-ratio', '1.000', COLD);

  // Phone width: the outline keeps its shape and fits the screen.
  await seedWaitingChat(fixture, { filename: 'bear.png', size: '1536x1024' }, { parked: false });
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  const narrow = await card.getByTestId('image-card-skeleton').boundingBox();
  expect(narrow!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  expect(narrow!.width / narrow!.height).toBeCloseTo(1.5, 1);
  await shot(page, testInfo, 'image-card-generating-mobile.png');
});

test('Preferences offers the org’s image models, saves the person’s pick, and is silent with none', async ({
  page,
}, testInfo) => {
  await signIn(page, fixture);

  // No image model in the org: the section is not there.
  await addModels(fixture, ['chat']);
  await page.goto(`/${fixture.slug}/preferences`);
  await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeVisible(COLD);
  await expect(page.getByRole('heading', { name: 'Image generation' })).toHaveCount(0);

  // Two image models: the picker, defaulting to the org's first by name.
  await addModels(fixture, ['painter', 'fox']);
  await page.reload();
  const select = page.getByLabel('Preferred image model');
  await expect(select).toBeVisible(COLD);
  await expect(select).toHaveValue('');
  await expect(select.locator('option').first()).toHaveText('Organization default (Fox)');
  await expect(select.locator('option')).toHaveText([
    'Organization default (Fox)',
    'Fox · FLUX.2-flex',
    'Painter · gpt-image-1',
  ]);
  const section = page.locator('section', { has: select });
  await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();

  await select.selectOption({ label: 'Painter · gpt-image-1' });
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  await shot(page, testInfo, 'preferences-image-model.png');

  // Saved: it survives a reload, and the stored preference is the model's id.
  await page.reload();
  await expect(page.getByLabel('Preferred image model')).toHaveValue(fixture.painterId);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const stored = await client.query(
      `SELECT value FROM user_preferences WHERE tenant_id = $1 AND subject = $2 AND key = 'image'`,
      [fixture.tenantId, fixture.subject]
    );
    expect(stored.rows[0].value).toEqual({ modelId: fixture.painterId });
  } finally {
    await client.end();
  }

  // Back to the organization default clears it.
  await page.getByLabel('Preferred image model').selectOption('');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();

  // Phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(page.getByLabel('Preferred image model')).toBeVisible();
  await shot(page, testInfo, 'preferences-image-model-mobile.png');
});

test('My usage and Organization usage count the pictures in KB/MB/GB with their tokens', async ({
  page,
}, testInfo) => {
  await addModels(fixture, ['chat', 'painter']);
  await seedUsage(fixture);
  await signIn(page, fixture);

  // Mine: two pictures, 4 million bytes, 101 tokens in and 5.2k out.
  await page.goto(`/${fixture.slug}/utilization`);
  const mine = page.getByRole('main').getByTestId('image-usage-card');
  await expect(mine).toBeVisible(COLD);
  await expect(mine.getByTestId('image-usage-count')).toHaveText('2');
  await expect(mine.getByTestId('image-usage-bytes')).toHaveText('3.8 MB');
  await expect(mine.getByTestId('image-usage-tokens')).toContainText('101 tokens in');
  await expect(mine.getByTestId('image-usage-tokens')).toContainText('5.2k tokens out');
  // And the same tokens are a surface of their own in "Tokens by surface".
  const mySurfaces = page.locator('section', {
    has: page.getByRole('heading', { name: 'Tokens by surface' }),
  });
  const myImages = mySurfaces.getByRole('listitem').filter({ hasText: 'Images' });
  await expect(myImages).toContainText('5.3k');
  await expect(myImages).toContainText('(101 in · 5.2k out)');
  await shot(page, testInfo, 'usage-images-mine.png');

  // The organization: three pictures, and who has the most.
  await page.goto(`/${fixture.slug}/admin/usage`);
  const org = page.getByRole('main').getByTestId('image-usage-card');
  await expect(org).toBeVisible(COLD);
  await expect(org.getByTestId('image-usage-count')).toHaveText('3');
  await expect(org.getByTestId('image-usage-bytes')).toHaveText('4.3 MB');
  // The tokens image models billed are a surface beside chat and agents, and part of the headline total.
  const surfaces = page.locator('section', {
    has: page.getByRole('heading', { name: 'Tokens by surface' }),
  });
  const surfaceImages = surfaces.getByRole('listitem').filter({ hasText: 'Images' });
  await expect(surfaceImages).toContainText('5.3k');
  await expect(surfaceImages).toContainText('(101 in · 5.2k out)');
  await expect(page.getByRole('main').getByText('5.3k', { exact: true }).first()).toBeVisible();
  const board = page.locator('section', {
    has: page.getByRole('heading', { name: 'Top image creators' }),
  });
  await expect(board).toBeVisible();
  await expect(board.getByText('E2E Tester')).toBeVisible();
  await expect(board.getByText('Another Person')).toBeVisible();
  await expect(board.getByText('3.8 MB · 2 images')).toBeVisible();
  await expect(board.getByText('488 KB · 1 image')).toBeVisible();
  await shot(page, testInfo, 'usage-images-org.png');

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(page.getByRole('main').getByTestId('image-usage-card')).toBeVisible();
  await shot(page, testInfo, 'usage-images-org-mobile.png');
});

test('the Tokens chart shows images by colour beside chat and agents, hour by hour and day by day', async ({
  page,
}, testInfo) => {
  await addModels(fixture, ['chat', 'painter']);
  await seedUsage(fixture);
  await signIn(page, fixture);
  const main = page.getByRole('main');
  // The chart's bars carry a tooltip; the ones with any tokens are the filled ones.
  const imageBars = main.locator('[role="img"] [title*="Images"]');

  await page.goto(`/${fixture.slug}/admin/usage`);
  await expect(main.getByTestId('image-usage-card')).toBeVisible(COLD);

  // There is no switch for images: the chart's own switch is Tokens, Agent runs, Tool calls.
  await expect(main.getByRole('button', { name: 'Images', exact: true })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Tokens', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // The legend names images with the other surfaces, in pink, distinct from the Agents purple.
  const legend = main.locator('figure').getByText('Images', { exact: true });
  await expect(legend).toBeVisible();
  await expect(legend.locator('span').first()).toHaveClass(/bg-pink-500/);

  // 30 days, by day: today's bar holds the image tokens, with how many pictures and how big.
  await expect(imageBars).toHaveCount(1);
  await expect(imageBars).toHaveAttribute('title', /Images 5,261 \(3 images, 4\.3 MB\)/);
  await expect(imageBars.locator('div.bg-pink-500')).toHaveCount(1);
  await shot(page, testInfo, 'usage-tokens-chart-images-daily.png');

  // Today, by hour: the same pink segment in the current hour's bar.
  await main.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(imageBars).toHaveCount(1);
  await expect(imageBars).toHaveAttribute('title', /Images 5,261 \(3 images, 4\.3 MB\)/);
  await expect(main.locator('figure').getByText('Today, by hour')).toBeVisible();
  await shot(page, testInfo, 'usage-tokens-chart-images-hourly.png');

  // The other series are untouched by images.
  await main.getByRole('button', { name: 'Agent runs', exact: true }).click();
  await expect(main.locator('[title*="Images"]')).toHaveCount(0);

  // My usage keeps its own input/output chart, with no Images switch.
  await page.goto(`/${fixture.slug}/utilization`);
  await expect(main.getByTestId('image-usage-card')).toBeVisible(COLD);
  await expect(main.getByRole('button', { name: 'Images', exact: true })).toHaveCount(0);

  // Phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/${fixture.slug}/admin/usage`);
  await expect(main.getByTestId('image-usage-card')).toBeVisible(COLD);
  await expect(imageBars).toHaveCount(1);
  await shot(page, testInfo, 'usage-tokens-chart-images-mobile.png');
});
