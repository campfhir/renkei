/**
 * The menu's chat list over the data store, on the memory implementation
 * (the Postgres side of the same reads is packages/db's differential
 * suite): the viewer's started chats, the ones shared with them by name
 * and the ones in their projects, each marked with how they got in and
 * the project's name; projects split into chat and code; an unexpired
 * grant only; and the "Load more" cursor when older chats exist.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { chatSidebarActiveSince, loadChatSidebar } from './sidebar';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

let store: MemoryDataStore;

/** Seeded rows are stored as given: each carries the columns the reads look at. */
const chat = (row: { id: string; owner_subject: string; title: string; updated_at: Date }) => ({
  project_id: null,
  llm_model_id: null,
  tool_config: null,
  archived_at: null,
  last_message_at: null,
  auto_title_asked: false,
  auto_mode: false,
  thinking_enabled: false,
  request_overhead_tokens: null,
  workspace_id: null,
  created_at: row.updated_at,
  ...row,
});
const project = (row: { id: string; owner_subject: string; name: string }) => ({
  kind: 'chat',
  description: null,
  instructions: null,
  tool_config: null,
  repo_provider: null,
  repo_full_name: null,
  repo_branch: null,
  workspace_id: null,
  published_to_org: false,
  created_at: daysAgo(10),
  updated_at: daysAgo(10),
  ...row,
});
const grant = (row: {
  resource_kind: string;
  resource_id: string;
  owner_subject: string;
  grantee_subject: string;
}) => ({
  id: id(100 + Number(row.resource_id.slice(-2))),
  role: 'viewer',
  expires_at: null,
  created_at: daysAgo(5),
  ...row,
});

beforeEach(async () => {
  store = createMemoryDataStore();
  registerDataStore(store);
  await store.seed({
    identities: [{ subject: 'bob', email: 'bob@example.test', display_name: 'Bob' }],
    chat_projects: [
      { id: id(1), owner_subject: 'ann', name: 'Alpha' },
      {
        id: id(2),
        owner_subject: 'bob',
        kind: 'code',
        name: 'Beta',
        repo_provider: 'github',
        repo_full_name: 'acme/beta',
      },
    ].map(project),
    chats: [
      {
        id: id(10),
        owner_subject: 'ann',
        title: 'mine',
        last_message_at: daysAgo(1),
        updated_at: daysAgo(1),
      },
      { id: id(11), owner_subject: 'ann', title: 'empty', updated_at: daysAgo(1) },
      {
        id: id(12),
        owner_subject: 'ann',
        title: 'old',
        last_message_at: daysAgo(200),
        updated_at: daysAgo(200),
      },
      {
        id: id(13),
        owner_subject: 'bob',
        title: 'shared',
        last_message_at: daysAgo(2),
        updated_at: daysAgo(2),
      },
      {
        id: id(14),
        owner_subject: 'bob',
        title: 'in beta',
        project_id: id(2),
        last_message_at: daysAgo(3),
        updated_at: daysAgo(3),
      },
      {
        id: id(15),
        owner_subject: 'bob',
        title: 'lapsed',
        last_message_at: daysAgo(2),
        updated_at: daysAgo(2),
      },
    ].map(chat),
    resource_access_grants: [
      { resource_kind: 'chat', resource_id: id(13), owner_subject: 'bob', grantee_subject: 'ann' },
      {
        resource_kind: 'chat',
        resource_id: id(15),
        owner_subject: 'bob',
        grantee_subject: 'ann',
        expires_at: daysAgo(1),
      },
      {
        resource_kind: 'chat_project',
        resource_id: id(2),
        owner_subject: 'bob',
        grantee_subject: 'ann',
        role: 'editor',
      },
    ].map(grant),
  });
});

afterAll(() => {
  resetDataStore();
});

describe('loadChatSidebar', () => {
  it('lists started chats by how the viewer reaches them, within the window', async () => {
    const sidebar = await loadChatSidebar('ann', { since: chatSidebarActiveSince() });
    expect(
      sidebar.chats.map((chat) => [chat.title, chat.via, chat.ownerName, chat.projectName])
    ).toEqual([
      ['mine', 'owner', null, null],
      ['shared', 'grant', 'Bob', null],
      ['in beta', 'project', 'Bob', 'Beta'],
    ]);
    expect(sidebar.moreChatsBefore).not.toBeNull();
  });

  it('splits chat projects from code projects, with the viewer’s role', async () => {
    const sidebar = await loadChatSidebar('ann');
    expect(sidebar.projects.map((project) => [project.name, project.role])).toEqual([
      ['Alpha', 'owner'],
    ]);
    expect(
      sidebar.code.projects.map((project) => [project.name, project.role, project.repoFullName])
    ).toEqual([['Beta', 'member', 'acme/beta']]);
    expect(sidebar.moreChatsBefore).toBeNull();
    expect(sidebar.chats.map((chat) => chat.title)).toContain('old');
  });

  it('shows someone else nothing of the viewer’s', async () => {
    const sidebar = await loadChatSidebar('cat');
    expect(sidebar).toEqual({
      chats: [],
      projects: [],
      code: { projects: [] },
      moreChatsBefore: null,
    });
  });
});
