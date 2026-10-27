/**
 * Connector marks, as the admin connector list shows them: the shipped
 * Salesforce, GitHub and Mirth Connect SVGs, and Renkei's own mark on its
 * built-in surfaces, load as images (not the
 * built-in fallback glyph, which is what a missing or malformed file
 * silently degrades to), and GitHub's near-black mark is inverted on a dark
 * page only (lib/connector-logos.ts, INVERT_ON_DARK). And on the person's
 * own Connectors page, every card's heading carries a mark that loads —
 * the page where a missing icon was noticed. Which cards render depends on
 * the org's setup; every one that does is checked.
 *
 * Its own operator, who adds every connector the org offers them to
 * their Connectors page through the catalog's own route
 * (PUT /api/connector-selections — one the org does not offer is refused,
 * and simply not added). The second test registers, under its own tag, the
 * two org-wide rows that put cards on that page (an ADManager Plus
 * instance and a file share) and removes them again.
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

const ADDED = [
  'jira',
  'atlassian-confluence',
  'atlassian-bitbucket',
  'microsoft',
  'entra-developer',
  'github',
  'salesforce',
  'webex',
  'zoom',
  'onbase',
  'onbase-admin',
  'fileshares',
  'mirth',
  'admanager',
];

/** Add what the org offers; the route refuses the rest, which stay off the page. */
async function addOffered(page: Page): Promise<void> {
  for (const connector of ADDED) {
    const response = await page.request.put('/api/connector-selections', { data: { connector } });
    expect([200, 400]).toContain(response.status());
  }
}

test('connector marks: shipped SVGs load, and GitHub inverts on dark only', async ({
  page,
  person: _person,
}, testInfo) => {
  await addOffered(page);
  await page.goto('/admin/connectors');
  const dark = testInfo.project.name.includes('dark');
  for (const [name, file] of [
    ['Salesforce', 'salesforce'],
    ['GitHub', 'github'],
    ['Mirth Connect', 'mirth'],
    ['Renkei cards', 'renkei'],
    ['Renkei agents', 'renkei'],
    ['Renkei batch jobs', 'renkei'],
    ['Renkei logs', 'renkei'],
    ['Renkei memory', 'renkei'],
    ['Renkei sandbox', 'renkei'],
  ] as const) {
    const row = page.locator('li').filter({ has: page.getByRole('link', { name, exact: true }) });
    const mark = row.locator(`img[src="/connector-logos/${file}.svg"]`);
    await expect(mark, `${name} shows its shipped mark`).toBeVisible();
    // Decoded as an image, so the file is a valid SVG (a wrong namespace
    // fails here) and the fallback glyph is not what is on screen.
    await expect
      .poll(() => mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expect(row.locator('svg[aria-hidden="true"] text')).toHaveCount(0);
    const filter = await mark.evaluate((img) => getComputedStyle(img).filter);
    expect(filter, `${name}'s filter`).toBe(file === 'github' && dark ? 'invert(1)' : 'none');
  }
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, 'connector-logos.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  // Salesforce and Salesforce Admin both wear it.
  await expect(page.locator('img[src="/connector-logos/salesforce.svg"]').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('connectors page: every card heading carries a mark that loads', async ({
  page,
  person: _person,
}, testInfo) => {
  // Two of the org-configured cards, offered the way an org offers them:
  // an ADManager Plus instance and a file share, registered (under this
  // test's tag) through the console's routes and removed again afterwards.
  const tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
  const instance = await page.request.post('/api/admin/admanager', {
    data: {
      name: `Logos ADManager ${tag}`,
      environment: 'prod',
      baseUrl: 'https://admp.example.com:8080',
      tlsVerify: true,
      allowInsecureHttp: false,
      resetPasswordTemplateName: null,
      enabled: true,
    },
  });
  expect(instance.ok(), await instance.text()).toBe(true);
  const share = await page.request.post('/api/admin/file-shares', {
    data: {
      name: `Logos share ${tag}`,
      protocol: 'smb',
      host: 'files.corp.example',
      port: null,
      shareName: 'reports',
      rootPath: '/',
      caseInsensitive: true,
      enabled: true,
      hostKeyFingerprint: null,
    },
  });
  expect(share.ok(), await share.text()).toBe(true);
  try {
    await addOffered(page);
    await checkCardMarks(page, testInfo);
  } finally {
    const instances: { instances: { id: string; name: string }[] } = await (
      await page.request.get('/api/admin/admanager')
    ).json();
    for (const row of instances.instances.filter((row) => row.name.endsWith(tag))) {
      await page.request.delete(`/api/admin/admanager/${row.id}`);
    }
    const shares: { shares: { id: string; name: string }[] } = await (
      await page.request.get('/api/admin/file-shares')
    ).json();
    for (const row of shares.shares.filter((row) => row.name.endsWith(tag))) {
      await page.request.delete(`/api/admin/file-shares/${row.id}`);
    }
  }
});

async function checkCardMarks(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto('/connectors');
  const headings = page.locator('[data-coach^="card-"] :is(h2, h3)');
  await expect(headings.first()).toBeVisible();
  const count = await headings.count();
  const seen: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const heading = headings.nth(i);
    if (!(await heading.isVisible())) continue;
    const name = (await heading.innerText()).trim();
    seen.push(name);
    const mark = heading.locator('img, svg').first();
    await expect(mark, `"${name}" has a mark`).toBeVisible();
    if ((await mark.evaluate((el) => el.tagName.toLowerCase())) === 'img') {
      await expect
        .poll(
          () => mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
          { message: `"${name}"'s mark loads` }
        )
        .toBe(true);
    }
  }
  // The org-configured cards that once had no mark render where the org
  // runs those servers — here, because the test registered them. (Browser
  // secrets, the other one, needs the sandbox browser, an org-wide switch
  // this read-only spec leaves alone; app/(app)/connectors/card-marks.test.ts
  // guards it.)
  expect(seen.some((heading) => heading.includes('ADManager Plus'))).toBe(true);
  expect(seen.some((heading) => heading.includes('File shares'))).toBe(true);
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, 'connectors-page-marks.png'),
    fullPage: true,
  });
}
