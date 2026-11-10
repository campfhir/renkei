/**
 * What the Jira administration specs stand on, staged the way people make
 * it:
 *
 *   - the org's Jira Administration app registered and switched on, with
 *     its whole ceiling of scopes (PUT /api/admin/connectors/atlassian-admin
 *     by an operator of the helper's own) — organization-wide, so it is
 *     switched on and left on, never off, as the code hosts are
 *     (e2e/support/code-host.ts);
 *   - the person's own connection, through the real connect flow: the
 *     card's authorize route, which on the in-memory app consents at once
 *     (fake OAuth, packages/provider-grants/src/fake-oauth.ts), and the
 *     callback storing the grant as production does.
 *
 * Each person is their own fake Atlassian account. The Jira site they work
 * in is their organization's (`fakeJiraSite`): people whose email
 * addresses share a domain share a site, and a person signed in with no
 * address of their own (the `person` fixture's) works in a site of their
 * own — so the stand-in Jira of e2e/sandbox-stub.mjs, which the app reaches
 * through JIRA_ADMIN_API_BASE_URL and which keeps every site's fields,
 * options and spaces apart, starts fresh for every test, and a spec can
 * read and stage the stub's state for that site the way someone working in
 * Jira by hand would.
 */

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  fakeAccount,
  fakeAtlassianSite,
} from '../../../../packages/provider-grants/src/fake-accounts';
import { MEMORY_BASE_URL, SANDBOX_STUB_URL } from '../constants';
import { askAndWait, createChat } from './code-host';
import {
  addConnectors,
  connectThrough,
  E2E_JSM_SCOPES,
  JSM_REQUEST_TYPE_SCOPES,
} from './connectors';

export { JSM_REQUEST_TYPE_SCOPES };
import { createPerson } from './person';
import { toolStep, scripted } from './stub-model';

/** The stand-in Jira's base: `${JIRA_STUB}/<cloud id>/rest/api/3/…`. */
export const JIRA_STUB = `${SANDBOX_STUB_URL}/jira`;

/** Every scope the app's default ceiling holds (lib/atlassian-scopes.ts). */
const FULL_CEILING = [
  'read:jira-user',
  'read:jira-work',
  'manage:jira-configuration',
  'manage:jira-project',
];

/** The Jira site a person's fake Atlassian account works in. */
/**
 * The Jira site a person works in: `organization` is their email
 * address's domain when they were given one, else their subject.
 */
export function fakeJiraSite(organization: string): { cloudId: string; url: string } {
  return fakeAtlassianSite(organization);
}

/** The fake Atlassian account a person connects as. */
export function fakeAtlassianName(subject: string): string {
  return fakeAccount(subject, 'atlassian-admin').displayName;
}

/** The org's Jira Administration app, on with its whole ceiling (left on). */
export async function prepareJiraAdministration(request: APIRequestContext): Promise<void> {
  const operator = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: 'Jira administration operator',
  });
  const route = `${MEMORY_BASE_URL}/api/admin/connectors/atlassian-admin`;
  const current = await request.get(route, { headers: operator.headers });
  expect(current.ok(), await current.text()).toBe(true);
  const body: unknown = await current.json();
  const read = (name: string): unknown =>
    typeof body === 'object' && body !== null ? Reflect.get(body, name) : undefined;
  const scopes = String(read('scopes') ?? '').split(' ');
  const ready =
    read('enabled') === true &&
    read('hasClientSecret') === true &&
    FULL_CEILING.every((scope) => scopes.includes(scope));
  if (ready) return;
  const saved = await request.put(route, {
    headers: operator.headers,
    data: {
      clientId: typeof read('clientId') === 'string' ? read('clientId') : 'e2e-admin-client',
      clientSecret: 'e2e-admin-secret',
      enabled: true,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

/**
 * Connect the page's person to Jira Administration through its card's
 * connect flow — with `scopes`, narrowed as the card's picker narrows it.
 * Ends on /connectors.
 */
export async function connectJiraAdministration(
  page: Page,
  scopes?: readonly string[]
): Promise<void> {
  await addConnectors(page.request, ['jira-admin']);
  const query = scopes ? `?scopes=${encodeURIComponent(scopes.join(' '))}` : '';
  await connectThrough(page, `/api/atlassian-admin/authorize${query}`);
}

/** Read from the stand-in Jira for an organization's site, as a record list. */
export async function jiraStub(
  subject: string,
  pathAndQuery: string
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${JIRA_STUB}/${fakeJiraSite(subject).cloudId}${pathAndQuery}`);
  const body: unknown = await response.json();
  const list: unknown[] = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return list.map((item) =>
    typeof item === 'object' && item !== null ? Object.fromEntries(Object.entries(item)) : {}
  );
}

/**
 * A tool call made the way a person's assistant makes it: a chat turn on
 * the stand-in model, whose prompt scripts the call (`scripted`,
 * ./stub-model.ts), waited out. Answers what
 * the tool answered, as text.
 */
export async function callInChat(
  page: Page,
  llmModelId: string,
  tool: string,
  input: Record<string, unknown>
): Promise<string> {
  const chatId = await createChat(page.request, { llmModelId });
  await askAndWait(page.request, chatId, {
    text: scripted('Please do this.', [toolStep(tool, input)]),
    llmModelId,
  });
  const response = await page.request.get(`/api/chat/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const body: unknown = await response.json();
  const messages: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'messages') : [];
  const results: string[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks: unknown =
      typeof message === 'object' && message !== null ? Reflect.get(message, 'blocks') : [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (typeof block !== 'object' || block === null) continue;
      if (Reflect.get(block, 'type') !== 'tool_result') continue;
      const content: unknown = Reflect.get(block, 'content');
      results.push(typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  return results.join('\n');
}

/**
 * Propose through a chat turn, and answer the change request's id, from
 * the review link the tool hands back.
 */
export async function proposeInChat(
  page: Page,
  llmModelId: string,
  tool: string,
  input: Record<string, unknown>
): Promise<string> {
  const answer = await callInChat(page, llmModelId, tool, input);
  const id = /\/jira-admin\/changes\/([0-9a-f-]{36})/.exec(answer)?.[1];
  expect(id, `${tool} answered: ${answer}`).toBeTruthy();
  return id ?? '';
}

/**
 * The org's Jira Service Management app, on, with "Set up request types"
 * allowed beside its defaults (left on, as Jira Administration is), saved
 * in one write with the scopes every spec registers it with.
 */
export async function prepareJiraServiceManagement(request: APIRequestContext): Promise<void> {
  const operator = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: 'Jira Service Management operator',
  });
  const route = `${MEMORY_BASE_URL}/api/admin/connectors/atlassian-jsm`;
  const current = await request.get(route, { headers: operator.headers });
  expect(current.ok(), await current.text()).toBe(true);
  const body: unknown = await current.json();
  const config: Record<string, unknown> =
    typeof body === 'object' && body !== null ? { ...body } : {};
  if (
    config.enabled === true &&
    config.hasClientSecret === true &&
    config.scopes === E2E_JSM_SCOPES
  ) {
    return;
  }
  const clientId =
    config.configured === true && typeof config.clientId === 'string' && config.clientId
      ? config.clientId
      : 'e2e-jsm-client';
  const saved = await request.put(route, {
    headers: operator.headers,
    data: { clientId, clientSecret: 'e2e-jsm-secret', enabled: true, scopes: E2E_JSM_SCOPES },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

/** Connect the page's person to Jira Service Management, with the scopes named. */
export async function connectJiraServiceManagement(
  page: Page,
  scopes: readonly string[]
): Promise<void> {
  await connectThrough(
    page,
    `/api/atlassian-jsm/authorize?scopes=${encodeURIComponent(scopes.join(' '))}`
  );
}
