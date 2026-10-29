import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const fixture = {
  pending_oidc_signin: [
    {
      id: id(1),
      state: 'state-sign-in',
      nonce: 'nonce-1',
      expires_at: at(10),
      created_at: at(0),
    },
    {
      id: id(2),
      state: 'state-connect',
      nonce: 'nonce-2',
      subject: 'ann',
      provider: 'salesforce',
      scopes: 'read write',
      code_verifier: 'verifier',
      connector_key: 'org-a',
      expires_at: at(11),
      created_at: at(1),
    },
  ],
};

export const pendingSigninScenarios: Scenario<DataStore>[] = [
  {
    method: 'pendingSignins.findByState',
    name: 'a sign-in, a connect, and an unknown state',
    fixture,
    run: async (store) => [
      await store.pendingSignins.findByState('state-sign-in'),
      await store.pendingSignins.findByState('state-connect'),
      await store.pendingSignins.findByState('nobody'),
    ],
  },
  {
    method: 'pendingSignins.create',
    name: 'optional fields default to null',
    fixture,
    run: async (store) => {
      await store.pendingSignins.create({
        id: id(3),
        state: 'state-new',
        nonce: 'nonce-3',
        subject: 'bob',
        provider: 'github',
        scopes: 'repo',
        expiresAt: new Date(at(12)),
        createdAt: new Date(at(2)),
      });
      await store.pendingSignins.create({
        id: id(4),
        state: 'state-bare',
        nonce: 'nonce-4',
        expiresAt: new Date(at(13)),
      });
      return {
        created: await store.pendingSignins.findByState('state-new'),
        bare: await store.pendingSignins.findByState('state-bare'),
        untouched: await store.pendingSignins.findByState('state-connect'),
      };
    },
  },
  {
    method: 'pendingSignins.deleteByState',
    name: 'spends one state, leaves the other; a second spend removes nothing',
    fixture,
    run: async (store) => [
      await store.pendingSignins.deleteByState('state-connect'),
      await store.pendingSignins.deleteByState('state-connect'),
      await store.pendingSignins.deleteByState('nobody'),
      await store.pendingSignins.findByState('state-connect'),
      (await store.pendingSignins.findByState('state-sign-in'))?.nonce,
    ],
  },
];
