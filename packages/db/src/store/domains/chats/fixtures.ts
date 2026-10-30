/**
 * Shared fixture rows for the chat and code domains' differential
 * scenarios (chats, chat-threads, chat-projects, resource-grants,
 * prompt-libraries, user-memory, artifacts, code-projects): fixed ids and
 * times, so both stores start from identical rows.
 */

import type { Row, TableRows } from '../../memory/tables';

/** A fixed v4-shaped uuid per number. */
export const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A fixed instant, `minute` minutes into 2026. */
export const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minute));
/** Far ahead and long ago, for expiry checks that must not depend on the clock. */
export const FUTURE = new Date(Date.UTC(2099, 0, 1));
export const PAST = new Date(Date.UTC(2001, 0, 1));

export const ANN = 'ann';
export const BOB = 'bob';
export const CAT = 'cat';

export const PROJECT = { annChat: uid(101), annCode: uid(102), bobChat: uid(103) };
export const CHAT = {
  annA: uid(201),
  annB: uid(202),
  annArchived: uid(203),
  annEmpty: uid(204),
  bobInAnnProject: uid(205),
  bobShared: uid(206),
  catPrivate: uid(207),
  annCode: uid(208),
};

/** A whole chat_projects row: the given columns over the table's defaults. */
export function projectRow(
  values: Pick<Row<'chat_projects'>, 'id' | 'owner_subject' | 'name'> &
    Partial<Row<'chat_projects'>>
): Row<'chat_projects'> {
  return {
    kind: 'chat',
    description: null,
    instructions: null,
    tool_config: null,
    repo_provider: null,
    repo_full_name: null,
    repo_branch: null,
    workspace_id: null,
    published_to_org: false,
    created_at: at(0),
    updated_at: at(0),
    ...values,
  };
}

/** A whole chats row: the given columns over the table's defaults. */
export function chatRow(
  values: Pick<Row<'chats'>, 'id' | 'owner_subject'> & Partial<Row<'chats'>>
): Row<'chats'> {
  return {
    title: null,
    project_id: null,
    llm_model_id: null,
    tool_config: null,
    archived_at: null,
    last_message_at: null,
    auto_title_asked: false,
    auto_mode: false,
    temporary: false,
    thinking_enabled: false,
    request_overhead_tokens: null,
    workspace_id: null,
    created_at: at(0),
    updated_at: at(0),
    ...values,
  };
}

/** A whole resource_access_grants row: the given columns over the table's defaults. */
export function grantRow(
  values: Pick<
    Row<'resource_access_grants'>,
    'id' | 'resource_kind' | 'resource_id' | 'owner_subject' | 'grantee_subject'
  > &
    Partial<Row<'resource_access_grants'>>
): Row<'resource_access_grants'> {
  return { role: 'viewer', expires_at: null, created_at: at(0), ...values };
}

/** A whole identities row. */
export function identityRow(
  values: Pick<Row<'identities'>, 'subject' | 'email'> & Partial<Row<'identities'>>
): Row<'identities'> {
  return { display_name: null, idp_groups: [], created_at: at(0), updated_at: at(0), ...values };
}

/** Projects, chats and grants: ann owns most of it, bob shares, cat stands outside. */
export function chatWorld(): TableRows {
  return {
    identities: [
      identityRow({ subject: ANN, email: 'ann@example.test', display_name: 'Ann' }),
      identityRow({ subject: BOB, email: 'bob@example.test', display_name: null }),
    ],
    chat_projects: [
      projectRow({
        id: PROJECT.annChat,
        owner_subject: ANN,
        name: 'alpha',
        description: 'first',
        instructions: 'sealed-instructions',
        tool_config: { connectors: ['jira'] },
        created_at: at(1),
        updated_at: at(10),
      }),
      projectRow({
        id: PROJECT.annCode,
        owner_subject: ANN,
        kind: 'code',
        name: 'beta',
        repo_provider: 'github',
        repo_full_name: 'acme/beta',
        repo_branch: 'main',
        workspace_id: uid(901),
        created_at: at(2),
        updated_at: at(10),
      }),
      projectRow({
        id: PROJECT.bobChat,
        owner_subject: BOB,
        name: 'gamma',
        created_at: at(3),
        updated_at: at(5),
      }),
    ],
    chats: [
      chatRow({
        id: CHAT.annA,
        owner_subject: ANN,
        title: 'A',
        project_id: PROJECT.annChat,
        last_message_at: at(20),
        created_at: at(4),
        updated_at: at(20),
        request_overhead_tokens: 1234,
      }),
      chatRow({
        id: CHAT.annB,
        owner_subject: ANN,
        title: null,
        tool_config: { connectors: ['slack'] },
        last_message_at: at(15),
        created_at: at(4),
        updated_at: at(20),
      }),
      chatRow({
        id: CHAT.annArchived,
        owner_subject: ANN,
        title: 'old',
        archived_at: at(9),
        last_message_at: at(6),
        created_at: at(5),
        updated_at: at(9),
      }),
      chatRow({ id: CHAT.annEmpty, owner_subject: ANN, created_at: at(30), updated_at: at(30) }),
      chatRow({
        id: CHAT.bobInAnnProject,
        owner_subject: BOB,
        title: 'bob in alpha',
        project_id: PROJECT.annChat,
        last_message_at: at(12),
        created_at: at(11),
        updated_at: at(12),
      }),
      chatRow({
        id: CHAT.bobShared,
        owner_subject: BOB,
        title: 'shared',
        last_message_at: at(14),
        created_at: at(13),
        updated_at: at(14),
      }),
      chatRow({
        id: CHAT.catPrivate,
        owner_subject: CAT,
        title: 'cat',
        last_message_at: at(16),
        created_at: at(16),
        updated_at: at(16),
      }),
      chatRow({
        id: CHAT.annCode,
        owner_subject: ANN,
        title: 'code chat',
        project_id: PROJECT.annCode,
        auto_mode: true,
        workspace_id: uid(902),
        last_message_at: at(8),
        created_at: at(7),
        updated_at: at(8),
      }),
    ],
    resource_access_grants: [
      grantRow({
        id: uid(301),
        resource_kind: 'chat',
        resource_id: CHAT.bobShared,
        owner_subject: BOB,
        grantee_subject: ANN,
        role: 'viewer',
        created_at: at(14),
      }),
      grantRow({
        id: uid(302),
        resource_kind: 'chat_project',
        resource_id: PROJECT.bobChat,
        owner_subject: BOB,
        grantee_subject: ANN,
        role: 'editor',
        expires_at: FUTURE,
        created_at: at(5),
      }),
      grantRow({
        id: uid(303),
        resource_kind: 'chat_project',
        resource_id: PROJECT.annChat,
        owner_subject: ANN,
        grantee_subject: BOB,
        role: 'viewer',
        created_at: at(6),
      }),
      grantRow({
        id: uid(304),
        resource_kind: 'chat',
        resource_id: CHAT.catPrivate,
        owner_subject: CAT,
        grantee_subject: ANN,
        role: 'viewer',
        expires_at: PAST,
        created_at: at(16),
      }),
      grantRow({
        id: uid(305),
        resource_kind: 'chat_project',
        resource_id: PROJECT.annChat,
        owner_subject: ANN,
        grantee_subject: CAT,
        role: 'viewer',
        expires_at: PAST,
        created_at: at(7),
      }),
    ],
  };
}
