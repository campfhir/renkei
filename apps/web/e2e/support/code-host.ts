/**
 * What the Code pages stand on, staged the way people make it:
 *
 *   - the organization's sandbox features on (an operator's
 *     PUT /api/admin/org-settings) and the Bitbucket OAuth consumer
 *     configured (PUT /api/admin/connectors/atlassian-bitbucket) — both
 *     organization-wide, so they are switched on and left on, never off;
 *   - the person's own Bitbucket connection, through the real connect
 *     flow: GET /api/atlassian-bitbucket/authorize, which on the
 *     in-memory app consents at once (fake OAuth,
 *     @renkei/provider-grants' fake-oauth.ts) and lands on
 *     /api/oauth/callback, where the grant is stored as production stores
 *     it; the repository APIs the token is then used on are the sandbox
 *     stub's (BITBUCKET_API_BASE_URL, GITHUB_API_BASE_URL);
 *   - a code project (POST /api/code/projects), chats in it
 *     (POST /api/chat/chats), and turns asked in them
 *     (POST …/turns) — a code chat's first turn clones the repository
 *     and gives the chat its worktree, as it does for a person.
 *
 * `setUpCode` does the first two and puts the stand-in model on the
 * roster (the page's person must be an operator); remove the model with
 * `removeModel` afterwards.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { MEMORY_BASE_URL } from '../constants';
import { createPerson } from './person';
import { addStubModel } from './stub-model';

async function ok(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string
): Promise<unknown> {
  if (!response.ok()) {
    throw new Error(`${what} answered ${response.status()}: ${await response.text()}`);
  }
  return response.json().catch(() => null);
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body
    ? Reflect.get(body, name)
    : undefined;
}

/** The org's OAuth app for each code host: its admin route and a test registration. */
const HOSTS = {
  bitbucket: {
    admin: '/api/admin/connectors/atlassian-bitbucket',
    registration: {
      clientId: 'e2e-bitbucket-client',
      clientSecret: 'e2e-bitbucket-secret',
      // Every scope the catalog offers, the admin bundle included (the
      // Pipelines switch stands on it): a connect without narrowing gets them all.
      scopes:
        'account repository project repository:write pullrequest pullrequest:write ' +
        'project:admin repository:admin pipeline pipeline:write pipeline:variable',
    },
    authorize: '/api/atlassian-bitbucket/authorize',
  },
  github: {
    admin: '/api/admin/connectors/github',
    registration: { clientId: 'e2e-github-client', clientSecret: 'e2e-github-secret' },
    authorize: '/api/github/authorize',
  },
} as const;

export type CodeHost = keyof typeof HOSTS;

/**
 * Sandbox features on and both code hosts' OAuth apps configured, by an
 * operator of the helper's own (the spec's person keeps the roles it
 * asked for).
 */
export async function prepareCodeHost(request: APIRequestContext): Promise<void> {
  const operator = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: 'Code host operator',
  });
  const headers = operator.headers;
  await ok(
    await request.put(`${MEMORY_BASE_URL}/api/admin/org-settings`, {
      headers,
      data: {
        sandboxBrowserEnabled: true,
        sandboxChartsEnabled: true,
        sandboxWorkspacesEnabled: true,
        sandboxServicesEnabled: true,
      },
    }),
    'PUT /api/admin/org-settings'
  );
  for (const host of Object.values(HOSTS)) {
    const current = await ok(
      await request.get(`${MEMORY_BASE_URL}${host.admin}`, { headers }),
      `GET ${host.admin}`
    );
    if (field(current, 'enabled') !== true || field(current, 'hasClientSecret') !== true) {
      await ok(
        await request.put(`${MEMORY_BASE_URL}${host.admin}`, {
          headers,
          data: host.registration,
        }),
        `PUT ${host.admin}`
      );
    }
  }
}

/**
 * Connect the page's person to a code host through its connect flow, as
 * the card's Connect link does; ends on /connectors. The in-memory app's
 * fake consent sends the browser straight back to the callback, and every
 * person is their own fake account.
 */
export async function connectCodeHost(page: Page, which: CodeHost): Promise<void> {
  await page.goto(HOSTS[which].authorize);
  await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
}

export async function connectBitbucket(page: Page): Promise<void> {
  await connectCodeHost(page, 'bitbucket');
}

export interface CodeProjectInput {
  /** Bitbucket unless named. */
  provider?: 'atlassian-bitbucket' | 'github';
  name: string;
  repository: string;
  branch?: string;
  description?: string;
  instructions?: string;
  env?: string;
}

/** A code project, the way the new-project form makes one; answers its id. */
export async function createCodeProject(
  request: APIRequestContext,
  input: CodeProjectInput
): Promise<string> {
  const body = await ok(
    await request.post('/api/code/projects', {
      data: { provider: 'atlassian-bitbucket', ...input },
    }),
    'POST /api/code/projects'
  );
  const id = field(body, 'projectId');
  if (typeof id !== 'string') throw new Error(`no projectId in ${JSON.stringify(body)}`);
  return id;
}

/** A chat (in a project when one is named), as "New chat" makes it, then titled; answers its id. */
export async function createChat(
  request: APIRequestContext,
  input: { projectId?: string; title?: string; llmModelId?: string }
): Promise<string> {
  const { title, ...create } = input;
  const body = await ok(
    await request.post('/api/chat/chats', { data: create }),
    'POST /api/chat/chats'
  );
  const id = field(body, 'chatId');
  if (typeof id !== 'string') throw new Error(`no chatId in ${JSON.stringify(body)}`);
  if (title) {
    await ok(
      await request.patch(`/api/chat/chats/${id}`, { data: { title } }),
      'PATCH /api/chat/chats/:id'
    );
  }
  return id;
}

/**
 * A turn asked in a chat (the composer's send) and waited out: in a code
 * project the first one clones the repository and gives the chat its
 * worktree (lib/code/turn.ts) before the model answers. The stand-in
 * model calls tools when the prompt scripts them (`scripted`,
 * ./stub-model.ts); a call the turn parks behind a
 * permission ask is allowed once, as the person's "Allow" does.
 */
export async function askAndWait(
  request: APIRequestContext,
  chatId: string,
  input: { text: string; llmModelId: string },
  timeoutMs = 60_000
): Promise<void> {
  await ok(
    await request.post(`/api/chat/chats/${chatId}/turns`, { data: input }),
    'POST /api/chat/chats/:id/turns'
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await ok(
      await request.get(`/api/chat/chats/${chatId}`),
      'GET /api/chat/chats/:id'
    );
    const chat = field(body, 'chat');
    const messages = field(body, 'messages');
    const active = field(chat, 'activeTurn');
    if (active === null && Array.isArray(messages) && messages.length > 1) return;
    const parked = field(active, 'pendingPermission');
    const toolUseId = field(parked, 'toolUseId');
    if (typeof toolUseId === 'string') {
      await ok(
        await request.post(`/api/chat/chats/${chatId}/turns/${field(active, 'id')}/permission`, {
          data: { toolUseId, decision: 'once' },
        }),
        'POST …/permission'
      );
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the turn in chat ${chatId} did not finish in ${timeoutMs}ms`);
}

/**
 * Everything a Code spec starts from, for the page's person (an
 * operator): the organization set up, their Bitbucket connected, and the
 * stand-in model on the roster, tagged. Answers the model's id.
 */
export async function setUpCode(
  page: Page,
  request: APIRequestContext,
  tag: string
): Promise<string> {
  await prepareCodeHost(request);
  await connectBitbucket(page);
  return addStubModel(page.request, tag);
}

export interface StagedCodeProject {
  projectId: string;
  /** In the order their titles were given. */
  chatIds: string[];
}

/**
 * A code project with chats in it. With `clone`, a turn is asked in each
 * chat first, so the project has its checkout and every chat its own
 * worktree, as a first chat leaves them.
 */
export async function stageCodeProject(
  request: APIRequestContext,
  input: CodeProjectInput & { chats?: string[]; clone?: boolean; llmModelId: string }
): Promise<StagedCodeProject> {
  const { chats = [], clone = false, llmModelId, ...project } = input;
  const projectId = await createCodeProject(request, project);
  const chatIds: string[] = [];
  for (const title of chats) {
    const chatId = await createChat(request, { projectId, title, llmModelId });
    if (clone) await askAndWait(request, chatId, { text: 'Clone it, please.', llmModelId });
    chatIds.push(chatId);
  }
  return { projectId, chatIds };
}
