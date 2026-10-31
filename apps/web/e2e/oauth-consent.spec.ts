/**
 * The MCP OAuth consent page: a signed-in browser sent to the authorize
 * endpoint by a client lands on a page naming the client, Deny returns
 * `access_denied` to the client's loopback callback, Allow returns a code
 * the client can exchange (with its PKCE verifier) for tokens, and the
 * same page at phone width still reads.
 *
 * The client registers itself the way an MCP client does (dynamic
 * registration, e2e/support/mcp-client.ts — the org setting that opens it
 * is put back as it was), once per project, under a name of its own. The person who
 * consents is the test's own, with a name of its own, so the audit
 * trail's lines (read on the Audit page by an operator) are theirs alone.
 * Pinned Chromium; mobile is a viewport resize.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { createPerson, signIn } from './support/person';
import { authorizeUrl, exchangeCode, registerClient, type McpClient } from './support/mcp-client';
import { MEMORY_BASE_URL } from './constants';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
/** A port no real listener holds; the callback is intercepted with page.route. */
const CALLBACK = 'http://127.0.0.1:47391/callback';

function tagOf(testInfo: TestInfo): string {
  return `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
}

/**
 * One registered client per project per worker, shared by this file's
 * tests: registration is rate-limited (ten per caller per ten minutes,
 * app/api/mcp/oauth/register), and a run that registered per test would
 * leave the next run on the same server refused.
 */
const clients = new Map<string, Promise<McpClient>>();
function clientFor(request: APIRequestContext, testInfo: TestInfo): Promise<McpClient> {
  const key = testInfo.project.name;
  let client = clients.get(key);
  if (!client) {
    const name = `Claude Code (e2e ${tagOf(testInfo)})`;
    client = createPerson(request, { roles: ['renkei-user', 'renkei-operator'] }).then((operator) =>
      registerClient(request, operator, name, CALLBACK)
    );
    clients.set(key, client);
  }
  return client;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/** Catch the client's loopback callback in the browser instead of letting it fail to connect. */
async function interceptCallback(page: Page): Promise<() => URL | null> {
  let landed: URL | null = null;
  await page.route(`${CALLBACK}**`, async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>callback</title><p data-testid="callback">callback reached</p>',
    });
  });
  return () => landed;
}

test('an MCP client must be allowed on the consent page before it gets a code @smoke', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const tag = tagOf(testInfo);
  const personName = `E2E Person ${tag}`;
  const operator = await createPerson(request, { roles: ['renkei-user', 'renkei-operator'] });
  const person = await createPerson(request, { displayName: personName });
  await signIn(page.context(), person);
  const client = await clientFor(request, testInfo);
  const clientName = client.clientName;
  const callback = await interceptCallback(page);

  // Deny first: the client hears access_denied and nothing was minted.
  await page.goto(authorizeUrl(client, 'state-deny').url);
  await expect(
    page.getByRole('heading', { name: `Allow ${clientName} to act as you?` })
  ).toBeVisible();
  await expect(page.getByText(personName)).toBeVisible();
  await expect(page.getByText('an application running on this computer')).toBeVisible();
  await expect(page.getByRole('note')).toContainText('registered itself less than an hour ago');
  await shot(page, testInfo, 'oauth-consent-01-page');

  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByTestId('callback')).toBeVisible();
  const denied = callback();
  expect(denied?.searchParams.get('error')).toBe('access_denied');
  expect(denied?.searchParams.get('state')).toBe('state-deny');
  expect(denied?.searchParams.get('code')).toBeNull();

  // Allow: the callback receives a code bound to this person and to the
  // S256 challenge — the client's verifier, and only it, redeems it.
  const allow = authorizeUrl(client, 'state-allow');
  await page.goto(allow.url);
  await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByTestId('callback')).toBeVisible();
  const allowed = callback();
  expect(allowed?.searchParams.get('state')).toBe('state-allow');
  const code = allowed?.searchParams.get('code') ?? '';
  expect(code).toMatch(/^code_/);
  const wrongVerifier = await request.post('/api/mcp/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: authorizeUrl(client, 'other').verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  });
  expect(wrongVerifier.ok()).toBe(false);
  const allowAgain = authorizeUrl(client, 'state-allow-2');
  await page.goto(allowAgain.url);
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByTestId('callback')).toBeVisible();
  const tokens = await exchangeCode(
    request,
    client,
    callback()?.searchParams.get('code') ?? '',
    allowAgain.verifier
  );
  expect(tokens.accessToken).toBeTruthy();

  // Both answers are on the audit trail, as this person.
  const operatorPage = await browser.newContext({
    reducedMotion: 'reduce',
    baseURL: MEMORY_BASE_URL,
  });
  await signIn(operatorPage, operator);
  const audit = await operatorPage.newPage();
  await audit.goto('/admin/audit');
  await expect(audit.getByText(`${personName} oauth.consent_denied`)).toBeVisible();
  await expect(audit.getByText(`${personName} oauth.consent_granted`).first()).toBeVisible();
  await operatorPage.close();

  // Phone width: the same page, buttons stacked, nothing clipped.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(authorizeUrl(client, 'state-mobile').url);
  await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  await shot(page, testInfo, 'oauth-consent-02-mobile');
});

test('a request without PKCE never reaches the consent page', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  const client = await clientFor(request, testInfo);

  // Asked the way the browser would (same cookies), but without following
  // the redirect: what matters is where the server sends it and with what.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: CALLBACK,
    state: 'no-pkce',
  });
  const response = await page.request.get(`/api/mcp/oauth/authorize?${query.toString()}`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  const landed = new URL(response.headers()['location']);
  expect(landed.origin).toBe(new URL(CALLBACK).origin);
  expect(landed.searchParams.get('error')).toBe('invalid_request');
  expect(landed.searchParams.get('error_description')).toMatch(/code_challenge/);
  expect(landed.searchParams.get('state')).toBe('no-pkce');
  expect(landed.searchParams.get('code')).toBeNull();
  // No consent request was opened: the client went back, not to the page.
  expect(landed.pathname).not.toContain('/oauth/consent');
});
