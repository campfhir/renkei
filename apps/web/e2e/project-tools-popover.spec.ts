/**
 * The Tools popover in an open project chat must inherit the PROJECT's own
 * toolset before falling back to the person's personal default — the same
 * chat ?? project ?? userDefault ?? built-in chain the server already
 * enforces in tool-config.ts's `effectiveToolConfig` (and start-turn.ts's
 * `executeChatTurn`). Before this fix, the popover's own fallback chain
 * (`selected ?? personal ?? core`) skipped the project tier entirely, so a
 * brand-new chat in a project showed the person's personal default instead
 * — and toggling any box there would have written that wrong set onto the
 * chat's own tool_config, permanently overriding the project's setting.
 * See AGENTS.md's "UI changes" section — the convention this spec follows.
 *
 * Own tenant per Playwright project (AGENTS.md's isolation rule): this spec
 * writes its own project and chat rows through the real creation path
 * (chat/new/page.tsx), so it must not share e2e/seed.ts's tenant with
 * specs running concurrently against the same dev database.
 */

import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

test.use({
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here (see voice.spec.ts / llm-models.spec.ts's note) — the
  // pinned Chromium runs every project instead.
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** A deterministic (stable across reruns), valid-looking v4 UUID from a seed string. */
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

/** This project's own tenant/session/project/slug — isolated from every other spec. */
function fixtureFor(projectName: string): {
  tenantId: string;
  sessionId: string;
  projectId: string;
  slug: string;
  subject: string;
} {
  return {
    tenantId: uuidFrom(`project-tools-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`project-tools-e2e-session:${projectName}`),
    projectId: uuidFrom(`project-tools-e2e-project:${projectName}`),
    slug: `e2e-project-tools-${projectName}`,
    subject: `e2e-project-tools-${projectName}@example.com`,
  };
}

async function seedTenant(fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Delete-then-insert, same idempotent shape as e2e/seed.ts, scoped to
    // just this project's own tenant.
    await client.query('DELETE FROM chats WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM chat_projects WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM user_preferences WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [
      fixture.tenantId,
      fixture.slug,
    ]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Tester']
    );
    // No coach marks tour stealing focus mid-test.
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    // This person's own personal chat default — deliberately just 'cards',
    // so it reads nothing like the project's own toolset (below) or the
    // built-in core set (agents, cards, knowledge, sandbox): a chat that
    // shows the wrong tier is unambiguous either way. ('knowledge' is left
    // out of both sets on purpose — its connector only registers once an
    // embedding provider is configured org-wide, which this fixture does
    // not set up; 'agents'/'cards'/'sandbox' need no such provisioning.)
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'chatTools', '{"connectors": ["cards"]}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    // The project's own toolset: agents only, no cards or sandbox —
    // distinct from both the personal default above and the core default.
    await client.query(
      `INSERT INTO chat_projects (id, tenant_id, owner_subject, name, tool_config)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        fixture.projectId,
        fixture.tenantId,
        fixture.subject,
        'Docs project',
        JSON.stringify({ connectors: ['agents'] }),
      ]
    );
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session_${fixture.tenantId}`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

test('a new chat in a project starts from the project’s toolset, not the person’s personal default', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  // "+ New" inside the project: the real creation path (chat/new/page.tsx)
  // — an empty chat with tool_config = NULL, same as clicking the
  // project's own "+ New chat" button.
  await page.goto(`/${fixture.slug}/chat/new?project=${fixture.projectId}`);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByText('Starts from this project’s toolset')).toBeVisible();

  // The project's own toolset (agents only) is what shows checked — not
  // the person's personal default (cards only) and not the built-in core
  // set (agents, cards, knowledge, sandbox). Before this fix the popover
  // fell straight through to the personal default, so agents would show
  // unchecked and cards would show checked — the exact inversion asserted
  // here.
  await expect(page.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Renkei cards/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Renkei sandbox/ })).not.toBeChecked();

  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/project-tools-popover-01-inherits-project.png`,
    fullPage: false,
  });

  // Mobile-width check (a resized Chromium viewport, not the `mobile`
  // project's device descriptor — AGENTS.md's note): the popover still
  // renders and reads correctly at phone width. The header switches to its
  // compact layout at this width, which remounts the popover (and closes
  // it), so it's reopened here.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/project-tools-popover-02-mobile.png`,
    fullPage: false,
  });
});
