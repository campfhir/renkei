import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-19${String(n).padStart(10, '0')}`;
const refusal = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : 'threw';
const NEW = 'renc2:%';
const USER = 'uenc1:%';

const message = (n: number, chat: number, content: string) => ({
  id: id(n),
  chat_id: id(chat),
  content,
  kind: 'text',
  role: 'user',
  seq: n,
});
const summary = (n: number, chat: number, content: string) => ({
  id: id(n),
  chat_id: id(chat),
  content,
  created_by: 'ann',
  folded_count: 1,
  through_seq: 1,
});
const run = (n: number, chat: number, task: string, rest: Record<string, string | null> = {}) => ({
  id: id(n),
  chat_id: id(chat),
  turn_id: id(9),
  tool_use_id: `t${n}`,
  max_steps: 3,
  task,
  ...rest,
});
const artifact = (n: number, kind: string, ref: number | null, text: string | null) => ({
  id: id(n),
  owner_subject: 'ann',
  blob_key: `b${n}`,
  content_type: 'text/plain',
  filename: `f${n}`,
  size_bytes: '1',
  key_kind: kind,
  key_ref: ref === null ? null : id(ref),
  extracted_text: text,
});
const grant = (
  provider: string,
  account: string,
  subject: string | null,
  at: string,
  rt: string
) => ({
  provider,
  provider_account_id: account,
  subject,
  client_id: 'c',
  display_name: account,
  encrypted_access_token: at,
  encrypted_refresh_token: rt,
  expires_at: '2026-01-01T00:00:00.000Z',
  requested_scopes: [],
});

const fixture = {
  chats: [
    { id: id(3), owner_subject: 'bob' },
    { id: id(1), owner_subject: 'ann' },
    { id: id(2), owner_subject: 'ann' },
  ],
  chat_turns: [{ id: id(9), chat_id: id(1) }],
  chat_projects: [
    { id: id(6), owner_subject: 'bob', name: 'B', instructions: null },
    { id: id(5), owner_subject: 'ann', name: 'A', instructions: 'renc1:i' },
  ],
  chat_messages: [
    message(12, 1, 'renc1:b'),
    message(11, 1, 'renc1:a'),
    message(13, 1, 'renc2:done'),
    message(14, 2, 'renc1:other'),
  ],
  chat_summaries: [summary(21, 1, 'plain words'), summary(22, 1, 'renc2:done')],
  chat_subagent_runs: [
    run(31, 1, 'renc1:task', { report: 'renc1:r', transcript: null }),
    run(32, 1, 'renc2:task'),
  ],
  artifacts: [
    artifact(41, 'chat', 1, 'renc1:x'),
    artifact(42, 'chat', 1, null),
    artifact(43, 'chat', 1, 'renc2:y'),
    artifact(44, 'chat_project', 5, 'renc1:p'),
    artifact(45, 'artifact', null, 'renc1:u'),
  ],
  chat_project_memories: [
    { id: id(52), project_id: id(5), content: 'renc1:m2' },
    { id: id(51), project_id: id(5), content: 'renc1:m1' },
    { id: id(53), project_id: id(6), content: 'renc2:m3' },
  ],
  chat_user_memories: [
    { id: id(62), owner_subject: 'bob', content: 'renc1:bob' },
    { id: id(61), owner_subject: 'ann', content: 'renc1:ann' },
    { id: id(63), owner_subject: 'ann', content: 'uenc1:done' },
  ],
  mirth_instances: [
    { id: id(70), name: 'M', base_url: 'https://m' },
    { id: id(71), name: 'N', base_url: 'https://n' },
  ],
  mirth_instance_connections: [
    { instance_id: id(70), subject: 'bob', username: 'u', encrypted_credentials: 'legacy-b' },
    { instance_id: id(71), subject: 'ann', username: 'u', encrypted_credentials: 'legacy-z' },
    { instance_id: id(70), subject: 'ann', username: 'u', encrypted_credentials: 'legacy-a' },
    { instance_id: id(70), subject: 'cy', username: 'u', encrypted_credentials: 'uenc1:done' },
  ],
  provider_grants: [
    grant('zoom', 'z1', 'ann', 'legacy', 'uenc1:r'),
    grant('github', 'g2', 'bob', 'uenc1:a', 'uenc1:r'),
    grant('github', 'g1', 'ann', 'uenc1:a', 'legacy'),
    grant('github', 'g0', null, 'legacy', 'legacy'),
  ],
};

export const legacyEnvelopeScenarios: Scenario<DataStore>[] = [
  {
    method: 'legacyEnvelopes.chatsPage',
    name: 'by id, after the last one, limited',
    fixture,
    run: async (store) => [
      await store.legacyEnvelopes.chatsPage(null, 2),
      await store.legacyEnvelopes.chatsPage(id(2), 2),
      await store.legacyEnvelopes.chatsPage(id(3), 2),
      await store.legacyEnvelopes.chatsPage('nope', 2).catch(refusal),
    ],
  },
  {
    method: 'legacyEnvelopes.projects',
    name: 'every project by id',
    fixture,
    run: async (store) => store.legacyEnvelopes.projects(),
  },
  {
    method: 'legacyEnvelopes.chatRows',
    name: "one chat's rows not yet moved, each by id; another chat's stay out",
    fixture,
    run: async (store) => [
      await store.legacyEnvelopes.chatRows(id(1), NEW),
      await store.legacyEnvelopes.chatRows(id(3), NEW),
    ],
  },
  {
    method: 'legacyEnvelopes.attachments',
    name: "the home's files with text not yet moved",
    fixture,
    run: async (store) => [
      await store.legacyEnvelopes.attachments('chat', id(1), NEW),
      await store.legacyEnvelopes.attachments('chat_project', id(5), NEW),
      await store.legacyEnvelopes.attachments('chat', id(5), NEW),
    ],
  },
  {
    method: 'legacyEnvelopes.projectMemories',
    name: "one project's memories not yet moved, by id",
    fixture,
    run: async (store) => [
      await store.legacyEnvelopes.projectMemories(id(5), NEW),
      await store.legacyEnvelopes.projectMemories(id(6), NEW),
    ],
  },
  {
    method: 'legacyEnvelopes.userMemories',
    name: "everyone's memories not yet under their key, by id",
    fixture,
    run: async (store) => store.legacyEnvelopes.userMemories(USER),
  },
  {
    method: 'legacyEnvelopes.credentials',
    name: 'rows not yet under their owner, by subject then value',
    fixture,
    run: async (store) => [
      await store.legacyEnvelopes.credentials('mirth_instance_connections', USER),
      await store.legacyEnvelopes.credentials('file_share_connections', USER),
    ],
  },
  {
    method: 'legacyEnvelopes.providerGrants',
    name: 'owned grants with either token not moved, by provider then account',
    fixture,
    run: async (store) => store.legacyEnvelopes.providerGrants(USER),
  },
  {
    method: 'legacyEnvelopes.reseal',
    name: 'each kind of row rewritten, only the columns given; reads after',
    fixture,
    run: async (store) => {
      const counts = [
        await store.legacyEnvelopes.reseal({
          table: 'chat_messages',
          id: id(11),
          content: 'renc2:a',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'chat_summaries',
          id: id(21),
          content: 'renc2:s',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'chat_subagent_runs',
          id: id(31),
          task: 'renc2:t',
        }),
        await store.legacyEnvelopes.reseal({ table: 'chat_subagent_runs', id: id(32) }),
        await store.legacyEnvelopes.reseal({
          table: 'artifacts',
          id: id(41),
          extractedText: 'renc2:x',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'chat_projects',
          id: id(5),
          instructions: 'renc2:i',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'chat_project_memories',
          id: id(51),
          content: 'renc2:m1',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'chat_user_memories',
          id: id(61),
          content: 'uenc1:ann',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'mirth_instance_connections',
          subject: 'ann',
          stored: 'legacy-a',
          next: 'uenc1:a',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'mirth_instance_connections',
          subject: 'ann',
          stored: 'changed-meanwhile',
          next: 'uenc1:z',
        }),
        await store.legacyEnvelopes.reseal({
          table: 'provider_grants',
          provider: 'github',
          accountId: 'g1',
          encryptedRefreshToken: 'uenc1:r',
        }),
        await store.legacyEnvelopes.reseal({ table: 'chat_messages', id: id(99), content: 'x' }),
      ];
      return [
        counts,
        await store.legacyEnvelopes.chatRows(id(1), NEW),
        await store.legacyEnvelopes.attachments('chat', id(1), NEW),
        await store.legacyEnvelopes.projects(),
        await store.legacyEnvelopes.projectMemories(id(5), NEW),
        await store.legacyEnvelopes.userMemories(USER),
        await store.legacyEnvelopes.credentials('mirth_instance_connections', USER),
        await store.legacyEnvelopes.providerGrants(USER),
      ];
    },
  },
];
