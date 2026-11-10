/**
 * The platform tools (platform-tools/), on the memory store: which of them
 * a turn has, which are offered up front and which wait behind find_tools,
 * and what each does for the person in the chat and refuses for anyone
 * else.
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { getThemePrefs } from '@renkei/user-prefs';
import { UTILIZATION_PERIODS } from '@/app/(app)/utilization/window';
import { ROLE_OPERATOR, ROLE_USER } from '@/lib/access';
import { isRecord } from '@renkei/guards';
import { grantResourceAccess } from '../access';
import { resourceCipher } from '../content-crypto';
import { createLocalToolSet, type LocalToolContext } from '../local-tools';
import { createProject, getProjectRow } from '../projects';
import { getLibrary, listPrompts } from '../prompts';
import { getDefaultChatTools } from '../tool-prefs';
import { findToolsTool, recallDiscoveredTools } from '../tool-discovery';
import { platformToolsFor, PLATFORM_CONNECTOR, PLATFORM_LABEL } from './index';
import { USAGE_PERIODS } from './usage';

const ME = 'ada';
const ORIGIN = 'https://renkei.example.org';

const HOSTS = [{ provider: 'github', label: 'GitHub' }];

function contextFor(
  subject = ME,
  overrides: Partial<LocalToolContext> = {}
): LocalToolContext & { changes: string[][] } {
  const changes: string[][] = [];
  return {
    subject,
    roles: [ROLE_USER],
    chatId: '00000000-0000-4000-8000-000000000001',
    // No tool here seals or opens chat content.
    cipher: resourceCipher({
      id: '00000000-0000-4000-8000-00000000c1fe',
      key: Buffer.alloc(32, 7),
    }),
    projectId: null,
    readOnly: false,
    origin: ORIGIN,
    emitPreferencesChanged: (change) => changes.push(change.documents),
    changes,
    ...overrides,
  };
}

const everything = () => createLocalToolSet(platformToolsFor({ operator: true, codeHosts: HOSTS }));

async function call(
  name: string,
  input: Record<string, unknown>,
  context: LocalToolContext = contextFor()
) {
  const result = await everything().run(name, input, context);
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return { text, isError: result.isError === true };
}

/** The uuid a result names after `label`, e.g. "library id <uuid>". */
function idAfter(text: string, label: string): string {
  const match = new RegExp(`${label} ([0-9a-f-]{36})`).exec(text);
  if (!match) throw new Error(`no ${label} in: ${text}`);
  return match[1];
}

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

describe('which platform tools a turn has', () => {
  const names = (options: Parameters<typeof platformToolsFor>[0]) =>
    platformToolsFor(options).map((tool) => tool.def.name);

  it('offers links, the person’s usage and their preferences up front; the rest waits behind find_tools', () => {
    const tools = platformToolsFor({ operator: true, codeHosts: HOSTS });
    expect(tools.filter((tool) => tool.deferred !== true).map((tool) => tool.def.name)).toEqual([
      'renkei_link',
      'renkei_my_usage',
      'renkei_get_preferences',
      'renkei_set_preferences',
    ]);
    expect(
      tools
        .filter((tool) => tool.deferred === true)
        .map((tool) => tool.def.name)
        .sort()
    ).toEqual([
      'renkei_create_chat_project',
      'renkei_create_code_project',
      'renkei_create_prompt_library',
      'renkei_delete_prompt',
      'renkei_list_projects',
      'renkei_list_prompt_libraries',
      'renkei_org_usage',
      'renkei_save_prompt',
    ]);
    // What is offered on every request is what the set declares; a deferred tool still runs.
    const set = createLocalToolSet(tools);
    expect(set.defs().map((def) => def.name)).not.toContain('renkei_save_prompt');
    expect(set.has('renkei_save_prompt')).toBe(true);
  });

  it('has organization usage only for an operator', () => {
    expect(names({ operator: false, codeHosts: [] })).not.toContain('renkei_org_usage');
    expect(names({ operator: true, codeHosts: [] })).toContain('renkei_org_usage');
  });

  it('has the code project tool only with a git host that can clone, push and open pull requests', () => {
    expect(names({ operator: false, codeHosts: [] })).not.toContain('renkei_create_code_project');
    const tool = platformToolsFor({ operator: false, codeHosts: HOSTS }).find(
      (entry) => entry.def.name === 'renkei_create_code_project'
    );
    expect(tool?.def.inputSchema).toMatchObject({
      properties: { provider: { enum: ['github'] } },
    });
  });

  it('only reads without asking: everything that changes something is an act', () => {
    const reads = platformToolsFor({ operator: true, codeHosts: HOSTS })
      .filter((tool) => tool.readOnly === true)
      .map((tool) => tool.def.name)
      .sort();
    expect(reads).toEqual([
      'renkei_get_preferences',
      'renkei_link',
      'renkei_list_projects',
      'renkei_list_prompt_libraries',
      'renkei_my_usage',
      'renkei_org_usage',
    ]);
  });
});

describe('finding the deferred tools', () => {
  const discoverable = () =>
    platformToolsFor({ operator: false, codeHosts: [] })
      .filter((tool) => tool.deferred === true)
      .map((tool) => ({ connector: PLATFORM_CONNECTOR, label: PLATFORM_LABEL, def: tool.def }));

  it('find_tools names the group and finds a tool by what it does', async () => {
    const tool = findToolsTool(discoverable());
    expect(tool?.def.description).toContain(`${PLATFORM_LABEL} (6)`);
    const found = await tool!.execute({ query: 'prompt library' }, contextFor());
    expect(found.isError).toBe(false);
    const discovered: unknown = found.meta?.discoveredTools;
    const names = Array.isArray(discovered)
      ? discovered.map((entry: unknown) => (isRecord(entry) ? entry.name : null))
      : [];
    expect(names).toEqual(
      expect.arrayContaining(['renkei_save_prompt', 'renkei_list_prompt_libraries'])
    );
  });

  it('a tool found on an earlier turn is offered again on the next', () => {
    const recalled = recallDiscoveredTools(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'u1', name: 'renkei_save_prompt', input: {} }],
        },
      ],
      discoverable()
    );
    expect(recalled.map((def) => def.name)).toEqual(['renkei_save_prompt']);
  });
});

describe('renkei_link', () => {
  it('builds every link on the address the person reached the app at', async () => {
    const { text } = await call('renkei_link', { to: 'my usage' });
    expect(text).toContain(`[My usage](${ORIGIN}/utilization)`);
    expect(text).not.toMatch(/\]\(\//);
  });

  it('reaches a setting down to the element that holds it', async () => {
    const { text } = await call('renkei_link', { to: 'dark mode' });
    expect(text).toContain(`${ORIGIN}/preferences#appearance-heading`);
  });

  it('keeps the organization’s pages for operators', async () => {
    const asUser = await call('renkei_link', { to: 'organization usage' });
    expect(asUser.text).not.toContain('/admin');
    const asOperator = await call(
      'renkei_link',
      { to: 'organization usage' },
      contextFor(ME, { roles: [ROLE_USER, ROLE_OPERATOR] })
    );
    expect(asOperator.text).toContain(`${ORIGIN}/admin/usage`);
  });

  it('finds the person’s own prompt library by name, and nobody else’s', async () => {
    const made = await call('renkei_create_prompt_library', { name: 'Quarterly reviews' });
    const libraryId = idAfter(made.text, 'library id');
    const mine = await call('renkei_link', { to: 'quarterly' });
    expect(mine.text).toContain(`${ORIGIN}/chat/prompts/${libraryId}`);
    const theirs = await call('renkei_link', { to: 'quarterly' }, contextFor('grace'));
    expect(theirs.isError).toBe(true);
  });

  it('lists the main pages when asked for nothing in particular', async () => {
    const { text } = await call('renkei_link', {});
    expect(text).toContain(`[Preferences](${ORIGIN}/preferences)`);
    expect(text).not.toContain('/admin');
  });
});

describe('usage', () => {
  it('offers the same windows the usage pages do', () => {
    expect(
      USAGE_PERIODS.map(({ key, days, endOffsetDays }) => ({ key, days, endOffsetDays }))
    ).toEqual(
      UTILIZATION_PERIODS.map(({ key, days, endOffsetDays }) => ({ key, days, endOffsetDays }))
    );
  });

  it('reports the person’s own numbers and points at their page', async () => {
    const { text, isError } = await call('renkei_my_usage', { period: '1w' });
    expect(isError).toBe(false);
    expect(text).toContain('the last 7 days');
    expect(text).toContain('No tokens were spent.');
    expect(text).toContain(`${ORIGIN}/utilization`);
  });

  it('refuses the organization’s numbers to a turn without the operator role, whatever was offered', async () => {
    const refused = await call('renkei_org_usage', {});
    expect(refused.isError).toBe(true);
    const allowed = await call('renkei_org_usage', {}, contextFor(ME, { roles: [ROLE_OPERATOR] }));
    expect(allowed.isError).toBe(false);
    expect(allowed.text).toContain(`${ORIGIN}/admin/usage`);
  });
});

describe('preferences', () => {
  it('a change is saved, read back, and announced so the open page re-renders', async () => {
    const context = contextFor();
    const saved = await call(
      'renkei_set_preferences',
      { theme: { mode: 'dark', codeLineNumbers: true } },
      context
    );
    expect(saved.isError).toBe(false);
    expect(await getThemePrefs(ME, { fresh: true })).toEqual({
      mode: 'dark',
      codeLineNumbers: true,
    });
    expect(context.changes).toEqual([['theme']]);
    const read = await call('renkei_get_preferences', {}, context);
    expect(read.text).toContain('"mode": "dark"');
  });

  it('changes only the fields sent', async () => {
    await call('renkei_set_preferences', { theme: { codeLineNumbers: true } });
    await call('renkei_set_preferences', { theme: { mode: 'light' } });
    expect(await getThemePrefs(ME, { fresh: true })).toEqual({
      mode: 'light',
      codeLineNumbers: true,
    });
  });

  it('a refused field saves nothing and announces nothing', async () => {
    const context = contextFor();
    const refused = await call(
      'renkei_set_preferences',
      { theme: { mode: 'dark' }, voice: { loudness: 11 } },
      context
    );
    expect(refused.isError).toBe(true);
    expect((await getThemePrefs(ME, { fresh: true })).mode).toBe('auto');
    expect(context.changes).toEqual([]);
  });

  it('never changes which tools run without asking', async () => {
    const context = contextFor();
    const refused = await call(
      'renkei_set_preferences',
      { toolPermissions: { alwaysAllow: ['renkei_set_preferences'] } },
      context
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Preferences page');
    expect(context.changes).toEqual([]);
  });

  it('refuses a default toolset naming a connector the person cannot turn on', async () => {
    const context = contextFor();
    const refused = await call(
      'renkei_set_preferences',
      { defaultTools: { chat: ['no-such-connector'] } },
      context
    );
    expect(refused.isError).toBe(true);
    expect(await getDefaultChatTools(ME, { fresh: true })).toBeNull();
    expect(context.changes).toEqual([]);
  });

  it('clears a default toolset, and says the defaults moved', async () => {
    const context = contextFor();
    const cleared = await call('renkei_set_preferences', { defaultTools: { code: null } }, context);
    expect(cleared.isError).toBe(false);
    expect(context.changes).toEqual([['defaultTools']]);
  });

  it('leaves the long notification settings out unless asked', async () => {
    expect((await call('renkei_get_preferences', {})).text).not.toContain('"notifications"');
    expect((await call('renkei_get_preferences', { includeNotifications: true })).text).toContain(
      '"notifications"'
    );
  });
});

describe('projects', () => {
  it('makes a chat project the person owns and hands back its link', async () => {
    const made = await call('renkei_create_chat_project', {
      name: 'Hiring',
      description: 'Interview loops',
    });
    expect(made.isError).toBe(false);
    const projectId = /\/chat\/projects\/([0-9a-f-]{36})/.exec(made.text)?.[1] ?? '';
    expect(made.text).toContain(`${ORIGIN}/chat/projects/${projectId}`);
    const project = await getProjectRow(projectId);
    expect(project).toMatchObject({ ownerSubject: ME, name: 'Hiring', kind: 'chat' });
  });

  it('a project needs a name', async () => {
    expect((await call('renkei_create_chat_project', { name: '  ' })).isError).toBe(true);
  });

  it('a code project is refused on a host the person’s connection does not cover', async () => {
    const refused = await call('renkei_create_code_project', {
      provider: 'atlassian-bitbucket',
      repository: 'team/app',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Nothing was made');
  });
});

describe('listing projects, and not making one twice', () => {
  const codeProject = (ownerSubject: string, fullName: string) =>
    createProject({
      ownerSubject,
      name: fullName.split('/')[1] ?? fullName,
      description: null,
      instructions: null,
      toolConfig: null,
      repo: { provider: 'github', fullName, branch: 'main' },
    });

  it('lists the person’s chat and code projects with their links and repositories, and no one else’s', async () => {
    await call('renkei_create_chat_project', { name: 'Hiring', description: 'Interview loops' });
    const codeId = await codeProject(ME, 'acme/site');
    await codeProject('grace', 'acme/secret');

    const listed = await call('renkei_list_projects', {});
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain('Hiring');
    expect(listed.text).toContain('chat project; theirs; Interview loops');
    expect(listed.text).toContain(`[site](${ORIGIN}/code/${codeId})`);
    expect(listed.text).toContain('code project on acme/site (GitHub, branch main)');
    expect(listed.text).not.toContain('secret');
  });

  it('includes a project shared with the person, and says who shares it', async () => {
    const sharedId = await codeProject('grace', 'acme/shared');
    await grantResourceAccess('grace', 'chat_project', sharedId ?? '', {
      granteeSubject: ME,
      role: 'editor',
      expiresAt: null,
    });
    const listed = await call('renkei_list_projects', { kind: 'code' });
    expect(listed.text).toContain(`${ORIGIN}/code/${sharedId}`);
    expect(listed.text).toContain('shared by grace');
  });

  it('narrows by kind and by words in the name or repository', async () => {
    await call('renkei_create_chat_project', { name: 'Hiring' });
    await codeProject(ME, 'acme/site');
    await codeProject(ME, 'acme/billing');
    const chatOnly = await call('renkei_list_projects', { kind: 'chat' });
    expect(chatOnly.text).toContain('Hiring');
    expect(chatOnly.text).not.toContain('acme/');
    const found = await call('renkei_list_projects', { query: 'billing' });
    expect(found.text).toContain('acme/billing');
    expect(found.text).not.toContain('acme/site');
    expect((await call('renkei_list_projects', { query: 'nothing-like-it' })).text).toContain(
      'No project'
    );
  });

  it('says so when the person has none', async () => {
    expect((await call('renkei_list_projects', {})).text).toContain('has no projects yet');
  });

  it('refuses a second code project on a repository the person already has one on, and links the first', async () => {
    const existingId = await codeProject(ME, 'acme/site');
    const refused = await call('renkei_create_code_project', {
      provider: 'github',
      repository: 'Acme/Site',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('already has a code project on acme/site');
    expect(refused.text).toContain(`${ORIGIN}/code/${existingId}`);
    expect(refused.text).toContain('Nothing was made');
    expect((await call('renkei_list_projects', { kind: 'code' })).text).toContain('1 code project');
  });

  it('counts a code project shared with the person as already there', async () => {
    const sharedId = await codeProject('grace', 'acme/shared');
    await grantResourceAccess('grace', 'chat_project', sharedId ?? '', {
      granteeSubject: ME,
      role: 'editor',
      expiresAt: null,
    });
    const refused = await call('renkei_create_code_project', {
      provider: 'github',
      repository: 'acme/shared',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('shared by grace');
  });

  it('refuses a second chat project under a name already used, unless a second one was asked for', async () => {
    await call('renkei_create_chat_project', { name: 'Hiring' });
    const refused = await call('renkei_create_chat_project', { name: 'hiring' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('already has a chat project called "hiring"');
    const second = await call('renkei_create_chat_project', {
      name: 'Hiring',
      allowDuplicate: true,
    });
    expect(second.isError).toBe(false);
    expect((await call('renkei_list_projects', { kind: 'chat' })).text).toContain('2 chat project');
  });
});

describe('prompt libraries', () => {
  async function library(name = 'Reviews') {
    return idAfter((await call('renkei_create_prompt_library', { name })).text, 'library id');
  }

  it('a prompt is saved, reworded and deleted in a library the person made', async () => {
    const libraryId = await library();
    expect(await getLibrary(libraryId)).toMatchObject({ ownerSubject: ME, name: 'Reviews' });

    const saved = await call('renkei_save_prompt', {
      libraryId,
      title: 'Summarize',
      body: 'Summarize the thread in five bullets.',
    });
    const promptId = idAfter(saved.text, 'prompt id');
    expect(await listPrompts(libraryId)).toMatchObject([{ title: 'Summarize' }]);

    const reworded = await call('renkei_save_prompt', {
      libraryId,
      promptId,
      body: 'Summarize the thread in three bullets.',
    });
    expect(reworded.isError).toBe(false);
    expect(await listPrompts(libraryId)).toMatchObject([
      { title: 'Summarize', body: 'Summarize the thread in three bullets.' },
    ]);

    const listed = await call('renkei_list_prompt_libraries', { libraryId });
    expect(listed.text).toContain('three bullets');
    expect((await call('renkei_list_prompt_libraries', {})).text).toContain('Reviews');

    const deleted = await call('renkei_delete_prompt', { libraryId, promptId });
    expect(deleted.isError).toBe(false);
    expect(deleted.text).toContain('"Summarize"');
    expect(await listPrompts(libraryId)).toEqual([]);
  });

  it('a new prompt needs both a title and a body', async () => {
    const libraryId = await library();
    expect((await call('renkei_save_prompt', { libraryId, title: 'Only a title' })).isError).toBe(
      true
    );
    expect(await listPrompts(libraryId)).toEqual([]);
  });

  it('a library the person cannot open reads as no such library', async () => {
    const libraryId = await library();
    const stranger = contextFor('grace');
    for (const [name, input] of [
      ['renkei_list_prompt_libraries', { libraryId }],
      ['renkei_save_prompt', { libraryId, title: 'x', body: 'y' }],
      ['renkei_delete_prompt', { libraryId, promptId: libraryId }],
    ] as const) {
      const refused = await call(name, input, stranger);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('No such prompt library');
    }
    expect(await listPrompts(libraryId)).toEqual([]);
  });

  it('a library shared to view can be read and not changed', async () => {
    const libraryId = await library();
    const saved = await call('renkei_save_prompt', { libraryId, title: 'Keep', body: 'Keep me.' });
    const promptId = idAfter(saved.text, 'prompt id');
    await grantResourceAccess(ME, 'prompt_library', libraryId, {
      granteeSubject: 'grace',
      role: 'viewer',
      expiresAt: null,
    });
    const viewer = contextFor('grace');
    expect((await call('renkei_list_prompt_libraries', { libraryId }, viewer)).text).toContain(
      'Keep me.'
    );
    const write = await call(
      'renkei_save_prompt',
      { libraryId, promptId, body: 'Changed' },
      viewer
    );
    expect(write.isError).toBe(true);
    const remove = await call('renkei_delete_prompt', { libraryId, promptId }, viewer);
    expect(remove.isError).toBe(true);
    expect(await listPrompts(libraryId)).toMatchObject([{ body: 'Keep me.' }]);
  });

  it('deleting a prompt that is not there deletes nothing', async () => {
    const libraryId = await library();
    const refused = await call('renkei_delete_prompt', {
      libraryId,
      promptId: '00000000-0000-4000-8000-00000000dead',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('nothing was deleted');
  });
});
