/**
 * The Access page's "Sign out everywhere": an operator ends another person's
 * browser sessions and MCP tokens from the row.
 *
 * Both people are the test's own. The target signs in (the test session
 * route) and holds an MCP client connection made the way a client makes
 * one: the client registers itself (e2e/support/mcp-client.ts), the
 * target allows it on the consent page in their own browser, and the
 * client exchanges the code for an access and a refresh token — the two
 * tokens the button ends, as its outcome line says. Then the operator's
 * own page still opens, and the row fits a phone.
 *
 * That they really stop working — the target's cookie, the bearer token
 * and the refresh token all refused afterwards — and the audit line are
 * app/api/admin/access/[subject]/revoke-sessions/route.test.ts, on the
 * memory store with the same authorize, consent and token routes.
 * Pinned Chromium; mobile is a viewport resize.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { createPerson, signIn } from './support/person';
import { authorizeUrl, exchangeCode, registerClient } from './support/mcp-client';
import { MEMORY_BASE_URL } from './constants';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const CALLBACK = 'http://127.0.0.1:47392/callback';

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('admin access: sign a person out everywhere', async ({ page, request, browser }, testInfo) => {
  const tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
  const operator = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: `Access Operator ${tag}`,
  });
  const target = await createPerson(request, { displayName: `Access Target ${tag}` });
  await signIn(page.context(), operator);

  // The target connects an MCP client: consent in their browser, tokens to the client.
  const client = await registerClient(request, operator, `Revoke client ${tag}`, CALLBACK);
  const targetContext = await browser.newContext({
    reducedMotion: 'reduce',
    baseURL: MEMORY_BASE_URL,
  });
  await signIn(targetContext, target);
  const targetPage = await targetContext.newPage();
  let code = '';
  await targetPage.route(`${CALLBACK}**`, async (route) => {
    code = new URL(route.request().url()).searchParams.get('code') ?? '';
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>callback</p>' });
  });
  const asked = authorizeUrl(client, 'revoke');
  await targetPage.goto(asked.url);
  await targetPage.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => code).toMatch(/^code_/);
  await targetContext.close();
  const tokens = await exchangeCode(request, client, code, asked.verifier);
  expect(tokens.refreshToken).toBeTruthy();

  await page.goto(`/admin/access`);
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();

  const button = page.getByTestId(`revoke-sessions-${target.subject}`).filter({ visible: true });
  await expect(button).toBeVisible();
  // Never offered on the operator's own row.
  await expect(page.getByTestId(`revoke-sessions-${operator.subject}`)).toHaveCount(0);
  await shot(page, testInfo, 'access-revoke-01-before');

  page.once('dialog', (dialog) => void dialog.accept());
  await button.click();

  const outcome = page.getByTestId(`revoke-sessions-outcome-${target.subject}`);
  await expect(outcome).toHaveText('Signed out: 1 session, 2 tokens');
  await shot(page, testInfo, 'access-revoke-02-after');

  // The operator's own session survived the operation.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByTestId(`revoke-sessions-${target.subject}`).filter({ visible: true })
  ).toBeVisible();
  await shot(page, testInfo, 'access-revoke-03-mobile');
});
