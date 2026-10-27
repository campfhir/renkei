/**
 * Shared fixture rows for the chat and code domains' differential
 * scenarios (chats, chat-threads, chat-projects, resource-grants,
 * prompt-libraries, user-memory, artifacts, code-projects): fixed ids and
 * times, so both stores start from identical rows.
 */

import type { TableRows } from '../../memory/tables';

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

/** Projects, chats and grants: ann owns most of it, bob shares, cat stands outside. */
export function chatWorld(): TableRows {
  return {
    identities: [
      { subject: ANN, email: 'ann@example.test', display_name: 'Ann' },
      { subject: BOB, email: 'bob@example.test', display_name: null },
    ],
    chat_projects: [
      {
        id: PROJECT.annChat,
        owner_subject: ANN,
        name: 'Alpha',
        description: 'first',
        instructions: 'sealed-instructions',
        tool_config: JSON.stringify({ connectors: ['jira'] }),
        created_at: at(1),
        updated_at: at(10),
      },
      {
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
      },
      {
        id: PROJECT.bobChat,
        owner_subject: BOB,
        name: 'Gamma',
        created_at: at(3),
        updated_at: at(5),
      },
    ],
    chats: [
      {
        id: CHAT.annA,
        owner_subject: ANN,
        title: 'A',
        project_id: PROJECT.annChat,
        last_message_at: at(20),
        created_at: at(4),
        updated_at: at(20),
        request_overhead_tokens: 1234,
      },
      {
        id: CHAT.annB,
        owner_subject: ANN,
        title: null,
        tool_config: JSON.stringify({ connectors: ['slack'] }),
        last_message_at: at(15),
        created_at: at(4),
        updated_at: at(20),
      },
      {
        id: CHAT.annArchived,
        owner_subject: ANN,
        title: 'old',
        archived_at: at(9),
        last_message_at: at(6),
        created_at: at(5),
        updated_at: at(9),
      },
      { id: CHAT.annEmpty, owner_subject: ANN, created_at: at(30), updated_at: at(30) },
      {
        id: CHAT.bobInAnnProject,
        owner_subject: BOB,
        title: 'bob in alpha',
        project_id: PROJECT.annChat,
        last_message_at: at(12),
        created_at: at(11),
        updated_at: at(12),
      },
      {
        id: CHAT.bobShared,
        owner_subject: BOB,
        title: 'shared',
        last_message_at: at(14),
        created_at: at(13),
        updated_at: at(14),
      },
      {
        id: CHAT.catPrivate,
        owner_subject: CAT,
        title: 'cat',
        last_message_at: at(16),
        created_at: at(16),
        updated_at: at(16),
      },
      {
        id: CHAT.annCode,
        owner_subject: ANN,
        title: 'code chat',
        project_id: PROJECT.annCode,
        auto_mode: true,
        workspace_id: uid(902),
        last_message_at: at(8),
        created_at: at(7),
        updated_at: at(8),
      },
    ],
    resource_access_grants: [
      {
        id: uid(301),
        resource_kind: 'chat',
        resource_id: CHAT.bobShared,
        owner_subject: BOB,
        grantee_subject: ANN,
        role: 'viewer',
        created_at: at(14),
      },
      {
        id: uid(302),
        resource_kind: 'chat_project',
        resource_id: PROJECT.bobChat,
        owner_subject: BOB,
        grantee_subject: ANN,
        role: 'editor',
        expires_at: FUTURE,
        created_at: at(5),
      },
      {
        id: uid(303),
        resource_kind: 'chat_project',
        resource_id: PROJECT.annChat,
        owner_subject: ANN,
        grantee_subject: BOB,
        role: 'viewer',
        created_at: at(6),
      },
      {
        id: uid(304),
        resource_kind: 'chat',
        resource_id: CHAT.catPrivate,
        owner_subject: CAT,
        grantee_subject: ANN,
        role: 'viewer',
        expires_at: PAST,
        created_at: at(16),
      },
      {
        id: uid(305),
        resource_kind: 'chat_project',
        resource_id: PROJECT.annChat,
        owner_subject: ANN,
        grantee_subject: CAT,
        role: 'viewer',
        expires_at: PAST,
        created_at: at(7),
      },
    ],
  };
}
