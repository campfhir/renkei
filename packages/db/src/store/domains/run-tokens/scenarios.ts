import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = new Date('2026-01-01T01:00:00.000Z');

const fixture = {
  oauth_clients: [
    {
      client_id: 'agent-runner',
      client_name: 'Runner',
      client_secret_hash: 'h0',
      redirect_uris: [],
    },
  ],
  oauth_access_tokens: [
    {
      token_hash: 'hash-a',
      client_id: 'agent-runner',
      subject: 'ann',
      application: 'agent',
      agent_id: null,
      expires_at: at,
      roles: ['renkei-user'],
    },
    {
      token_hash: 'hash-b',
      client_id: 'agent-runner',
      subject: 'bob',
      application: 'widget',
      agent_id: null,
      expires_at: at,
      tool_names: ['jira_confirm'],
    },
  ],
};

const token = {
  tokenHash: 'hash-new',
  clientId: 'agent-runner',
  subject: 'ann',
  application: 'agent',
  agentId: null,
  scope: null,
  toolNames: ['a', 'b'],
  expiresAt: new Date(at),
};

export const runTokenScenarios: Scenario<DataStore>[] = [
  {
    method: 'runTokens.ensureClient',
    name: 'creates once; an existing client is left alone',
    run: async (store) => {
      await store.runTokens.ensureClient({
        clientId: 'agent-runner',
        clientName: 'Runner',
        secretHash: 'h1',
      });
      await store.runTokens.ensureClient({
        clientId: 'agent-runner',
        clientName: 'Other',
        secretHash: 'h2',
      });
      await store.runTokens.insert(token);
      return store.runTokens.find('hash-new');
    },
  },
  {
    method: 'runTokens.insert',
    name: 'with and without roles',
    fixture,
    run: async (store) => {
      await store.runTokens.insert(token);
      await store.runTokens.insert({
        ...token,
        tokenHash: 'hash-roles',
        roles: ['renkei-operator'],
      });
      await store.runTokens.insert({
        ...token,
        tokenHash: 'hash-scope',
        sandboxScope: 'chat:00000000-0000-4000-8000-0000000000c1',
      });
      return {
        plain: await store.runTokens.find('hash-new'),
        roles: await store.runTokens.find('hash-roles'),
        scoped: await store.runTokens.find('hash-scope'),
      };
    },
  },
  {
    method: 'runTokens.delete',
    name: 'by digest only',
    fixture,
    run: async (store) => [
      await store.runTokens.delete('hash-a'),
      await store.runTokens.delete('hash-a'),
      await store.runTokens.find('hash-a'),
      await store.runTokens.find('hash-b'),
    ],
  },
  {
    method: 'runTokens.find',
    name: 'as stored; an unknown digest reads null',
    fixture,
    run: async (store) => [
      await store.runTokens.find('hash-a'),
      await store.runTokens.find('hash-b'),
      await store.runTokens.find('nope'),
    ],
  },
];
