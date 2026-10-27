import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function request(n: number, minute: number, client = 'cli-a') {
  return {
    id: id(n),
    client_id: client,
    session_id: id(50),
    subject: 'ann',
    redirect_uri: 'http://127.0.0.1:3000/cb',
    state: `state-${n}`,
    scope: n === 2 ? null : 'openid',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    expires_at: at(minute),
  };
}

const fixture = {
  sessions: [{ id: id(50), subject: 'ann', expires_at: at(500) }],
  oauth_clients: [
    {
      client_id: 'cli-a',
      client_name: 'Desktop client',
      client_secret_hash: 'h',
      redirect_uris: ['http://127.0.0.1:3000/cb'],
      created_at: at(0),
    },
    {
      client_id: 'cli-b',
      client_name: null,
      client_secret_hash: 'h',
      redirect_uris: [],
      created_at: at(1),
    },
  ],
  oauth_consent_requests: [request(1, 10), request(2, 30, 'cli-b'), request(3, 20)],
};

export const oauthConsentScenarios: Scenario<DataStore>[] = [
  {
    method: 'oauthConsents.getClient',
    name: 'by client id',
    fixture,
    run: async (store) => [
      await store.oauthConsents.getClient('cli-a'),
      await store.oauthConsents.getClient('cli-b'),
      await store.oauthConsents.getClient('nope'),
    ],
  },
  {
    method: 'oauthConsents.getRequest',
    name: 'with the client name and registration; unknown and malformed ids',
    fixture,
    run: async (store) => [
      await store.oauthConsents.getRequest(id(1)),
      await store.oauthConsents.getRequest(id(2)),
      await store.oauthConsents.getRequest(id(9)),
      await store.oauthConsents.getRequest('nope').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      ),
    ],
  },
  {
    method: 'oauthConsents.sweepExpired',
    name: 'strictly before now',
    fixture,
    run: async (store) => [
      await store.oauthConsents.sweepExpired(at(20)),
      (await store.oauthConsents.getRequest(id(1)))?.id ?? null,
      (await store.oauthConsents.getRequest(id(3)))?.id ?? null,
      await store.oauthConsents.sweepExpired(at(0)),
    ],
  },
  {
    method: 'oauthConsents.createRequest',
    name: 'readable after; unknown client refused',
    fixture,
    run: async (store) => {
      const fresh = {
        id: id(7),
        clientId: 'cli-a',
        sessionId: id(50),
        subject: 'ann',
        redirectUri: 'http://127.0.0.1:3000/cb',
        state: 's',
        scope: 'openid profile email',
        codeChallenge: 'c',
        codeChallengeMethod: 'S256',
        expiresAt: at(40),
      };
      await store.oauthConsents.createRequest(fresh);
      const orphan = await store.oauthConsents
        .createRequest({ ...fresh, id: id(8), clientId: 'nope' })
        .then(
          () => 'accepted',
          (error: { code?: string }) => error.code
        );
      return { read: await store.oauthConsents.getRequest(id(7)), orphan };
    },
  },
  {
    method: 'oauthConsents.takeRequest',
    name: 'spent on the first answer',
    fixture,
    run: async (store) => [
      await store.oauthConsents.takeRequest(id(1)),
      await store.oauthConsents.takeRequest(id(1)),
      await store.oauthConsents.getRequest(id(1)),
    ],
  },
  {
    method: 'oauthConsents.insertAuthorizationCode',
    name: 'stores once; a reused code is refused',
    fixture,
    run: async (store) => {
      const code = {
        code: 'code_1',
        clientId: 'cli-a',
        subject: 'ann',
        scope: 'openid',
        redirectUri: 'http://127.0.0.1:3000/cb',
        codeChallenge: 'c',
        codeChallengeMethod: 'S256',
        roles: ['renkei-user'],
        expiresAt: at(60),
      };
      await store.oauthConsents.insertAuthorizationCode(code);
      return store.oauthConsents.insertAuthorizationCode(code).then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
    },
  },
  {
    method: 'oauthConsents.registerClient',
    name: 'registers a client readable by id; a taken id is refused',
    fixture,
    run: async (store) => {
      const client = {
        clientId: 'client_new',
        clientSecretHash: 'digest',
        clientName: 'New tool',
        redirectUris: ['http://127.0.0.1:4000/cb', 'https://tool.test/cb'],
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      };
      await store.oauthConsents.registerClient(client);
      await store.oauthConsents.registerClient({
        ...client,
        clientId: 'client_unnamed',
        clientName: null,
      });
      const again = await store.oauthConsents.registerClient(client).then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
      const read = async (id: string) => {
        const found = await store.oauthConsents.getClient(id);
        return found && { ...found, createdAt: undefined };
      };
      return {
        again,
        created: await read('client_new'),
        unnamed: await read('client_unnamed'),
        existing: await read('cli-a'),
      };
    },
  },
];
