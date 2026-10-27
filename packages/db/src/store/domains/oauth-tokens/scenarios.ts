import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const clients = [
  {
    client_id: 'cli-a',
    client_name: 'A',
    client_secret_hash: 'h',
    redirect_uris: ['http://127.0.0.1/cb'],
    created_at: at(0),
  },
  {
    client_id: 'cli-b',
    client_name: 'B',
    client_secret_hash: 'h',
    redirect_uris: ['http://127.0.0.1/cb'],
    created_at: at(0),
  },
];

function access(hash: string, application: string, subject = 'ann', client = 'cli-a') {
  return {
    token_hash: hash,
    client_id: client,
    subject,
    application,
    scope: 'openid',
    roles: ['renkei-user'],
    expires_at: at(60),
  };
}

function refresh(
  n: number,
  hash: string,
  options: { family?: number; rotated?: Date | null; expires?: Date; subject?: string } = {}
) {
  return {
    token_id: id(n),
    client_id: 'cli-a',
    subject: options.subject ?? 'ann',
    scope: 'openid',
    roles: ['frozen'],
    token_hash: hash,
    family_id: id(100 + (options.family ?? 1)),
    rotated_at: options.rotated ?? null,
    expires_at: options.expires ?? at(500),
  };
}

const fixture = {
  oauth_clients: clients,
  oauth_access_tokens: [
    access('a1', 'jira'),
    access('a2', 'agent'),
    { ...access('a3', 'jira', 'bob'), agent_id: null, tool_names: ['x'] },
    access('a4', 'jira', 'ann', 'cli-b'),
  ],
  oauth_refresh_tokens: [
    refresh(1, 'r-live'),
    refresh(2, 'r-old', { rotated: at(5) }),
    refresh(3, 'r-expired', { family: 2, expires: at(10) }),
    refresh(4, 'r-expired-sibling', { family: 2, expires: at(10), rotated: at(1) }),
    refresh(5, 'r-bob', { family: 3, subject: 'bob' }),
  ],
  sessions: [
    { id: id(50), subject: 'ann', roles: ['old'], created_at: at(1), expires_at: at(900) },
    { id: id(51), subject: 'ann', roles: ['newest'], created_at: at(9), expires_at: at(900) },
    { id: id(52), subject: 'ann', roles: ['dead'], created_at: at(19), expires_at: at(15) },
  ],
};

const rotate = (store: DataStore, presentedHash: string, clientId = 'cli-a') =>
  store.oauthTokens.rotateRefreshToken({
    presentedHash,
    clientId,
    now: at(20),
    next: { tokenId: id(9), tokenHash: 'r-next' },
    access: { tokenHash: 'a-next', expiresAt: at(80) },
  });

export const oauthTokenScenarios: Scenario<DataStore>[] = [
  {
    method: 'oauthTokens.findAccessToken',
    name: 'by digest and application only',
    fixture,
    run: async (store) => [
      await store.oauthTokens.findAccessToken('a1', 'jira'),
      await store.oauthTokens.findAccessToken('a1', 'agent'),
      await store.oauthTokens.findAccessToken('a2', 'agent'),
      await store.oauthTokens.findAccessToken('a3', 'jira'),
      await store.oauthTokens.findAccessToken('nope', 'jira'),
    ],
  },
  {
    method: 'oauthTokens.insertAccessToken',
    name: 'readable after; a reused digest is refused',
    fixture,
    run: async (store) => {
      const token = {
        tokenHash: 'fresh',
        clientId: 'cli-a',
        subject: 'ann',
        application: 'widget',
        scope: null,
        roles: [],
        expiresAt: at(30),
      };
      await store.oauthTokens.insertAccessToken(token);
      const again = await store.oauthTokens.insertAccessToken(token).then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
      return { again, read: await store.oauthTokens.findAccessToken('fresh', 'widget') };
    },
  },
  {
    method: 'oauthTokens.deleteAccessToken',
    name: 'one digest, once',
    fixture,
    run: async (store) => [
      await store.oauthTokens.deleteAccessToken('a1'),
      await store.oauthTokens.deleteAccessToken('a1'),
      await store.oauthTokens.findAccessToken('a1', 'jira'),
      (await store.oauthTokens.findAccessToken('a2', 'agent'))?.tokenHash ?? null,
    ],
  },
  {
    method: 'oauthTokens.insertRefreshToken',
    name: 'a fresh family that rotates',
    fixture: { oauth_clients: clients },
    run: async (store) => {
      await store.oauthTokens.insertRefreshToken({
        tokenId: id(7),
        clientId: 'cli-a',
        subject: 'ann',
        scope: null,
        roles: ['r'],
        tokenHash: 'r-new',
        expiresAt: at(100),
      });
      const first = await rotate(store, 'r-new');
      const replay = await rotate(store, 'r-new');
      return { first, replay: replay.outcome };
    },
  },
  {
    method: 'oauthTokens.rotateRefreshToken',
    name: 'unknown, wrong client and expired (the family goes)',
    fixture,
    run: async (store) => [
      await rotate(store, 'nope'),
      await rotate(store, 'r-live', 'cli-b'),
      await rotate(store, 'r-expired'),
      (await rotate(store, 'r-expired-sibling')).outcome,
    ],
  },
  {
    method: 'oauthTokens.rotateRefreshToken',
    name: 'reuse revokes the family and the jira tokens of that client',
    fixture,
    run: async (store) => [
      await rotate(store, 'r-old'),
      (await rotate(store, 'r-live')).outcome,
      await store.oauthTokens.findAccessToken('a1', 'jira'),
      (await store.oauthTokens.findAccessToken('a2', 'agent'))?.tokenHash ?? null,
      (await store.oauthTokens.findAccessToken('a4', 'jira'))?.tokenHash ?? null,
      (await rotate(store, 'r-bob')).outcome,
    ],
  },
  {
    method: 'oauthTokens.rotateRefreshToken',
    name: 'rotation takes the newest live session roles; a session-less subject keeps its own',
    fixture,
    run: async (store) => {
      const rotated = await rotate(store, 'r-live');
      const token = await store.oauthTokens.findAccessToken('a-next', 'jira');
      const successor = await store.oauthTokens.rotateRefreshToken({
        presentedHash: 'r-next',
        clientId: 'cli-a',
        now: at(21),
        next: { tokenId: id(10), tokenHash: 'r-next-2' },
        access: { tokenHash: 'a-next-2', expiresAt: at(81) },
      });
      const bob = await store.oauthTokens.rotateRefreshToken({
        presentedHash: 'r-bob',
        clientId: 'cli-a',
        now: at(21),
        next: { tokenId: id(11), tokenHash: 'r-bob-2' },
        access: { tokenHash: 'a-bob-2', expiresAt: at(81) },
      });
      return { rotated, token, successor, bob, replay: (await rotate(store, 'r-live')).outcome };
    },
  },
];
