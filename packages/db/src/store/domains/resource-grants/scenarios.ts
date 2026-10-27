import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CAT, CHAT, FUTURE, PAST, PROJECT, chatWorld, uid } from '../chats/fixtures';

const fixture = chatWorld();

export const resourceGrantScenarios: Scenario<DataStore>[] = [
  {
    method: 'resourceGrants.ownerOf',
    name: 'per kind, missing and malformed ids',
    fixture: {
      ...fixture,
      prompt_libraries: [{ id: uid(401), owner_subject: CAT, name: 'L' }],
    },
    run: async (store) => [
      await store.resourceGrants.ownerOf('chat', CHAT.bobShared),
      await store.resourceGrants.ownerOf('chat_project', PROJECT.annChat),
      await store.resourceGrants.ownerOf('prompt_library', uid(401)),
      await store.resourceGrants.ownerOf('artifact', uid(999)),
      await store.resourceGrants.ownerOf('chat', CHAT.annA.toUpperCase()),
      await store.resourceGrants.ownerOf('chat', 'nope').then(
        () => 'accepted',
        (error: { code?: string }) => error.code ?? 'refused'
      ),
    ],
  },
  {
    method: 'resourceGrants.activeRole',
    name: 'unexpired only, per grantee and kind',
    fixture,
    run: async (store) => [
      await store.resourceGrants.activeRole('chat', CHAT.bobShared, ANN),
      await store.resourceGrants.activeRole('chat_project', PROJECT.bobChat, ANN),
      await store.resourceGrants.activeRole('chat', CHAT.catPrivate, ANN),
      await store.resourceGrants.activeRole('chat_project', CHAT.bobShared, ANN),
      await store.resourceGrants.activeRole('chat', CHAT.bobShared, CAT),
    ],
  },
  {
    method: 'resourceGrants.listForGrantee',
    name: 'unexpired, oldest first, of one kind',
    fixture,
    run: async (store) => [
      await store.resourceGrants.listForGrantee(ANN, 'chat'),
      await store.resourceGrants.listForGrantee(ANN, 'chat_project'),
      await store.resourceGrants.listForGrantee(CAT, 'chat_project'),
      await store.resourceGrants.listForGrantee('nobody', 'chat'),
    ],
  },
  {
    method: 'resourceGrants.activeGrantees',
    name: 'expired grantees left out',
    fixture,
    run: async (store) => [
      await store.resourceGrants.activeGrantees('chat_project', PROJECT.annChat),
      await store.resourceGrants.activeGrantees('chat', CHAT.catPrivate),
      await store.resourceGrants.activeGrantees('chat', uid(999)),
    ],
  },
  {
    method: 'resourceGrants.upsert',
    name: 'insert, then refresh role and expiry in place',
    fixture,
    run: async (store) => {
      const grant = {
        resourceKind: 'chat_project',
        resourceId: PROJECT.annChat,
        ownerSubject: ANN,
        granteeSubject: CAT,
        role: 'editor',
        expiresAt: FUTURE,
      };
      await store.resourceGrants.upsert(grant);
      const first = await store.resourceGrants.activeRole('chat_project', PROJECT.annChat, CAT);
      await store.resourceGrants.upsert({ ...grant, role: 'viewer', expiresAt: null });
      await store.resourceGrants.upsert({ ...grant, granteeSubject: 'dan', expiresAt: PAST });
      const rows = await store.resourceGrants.listForOwner(ANN, 'chat_project', PROJECT.annChat);
      return {
        first,
        rows: rows.map((row) => [row.granteeSubject, row.role, row.expiresAt]),
      };
    },
  },
  {
    method: 'resourceGrants.listForOwner',
    name: 'expired included, newest first, with names; owner only',
    fixture,
    run: async (store) => [
      await store.resourceGrants.listForOwner(ANN, 'chat_project', PROJECT.annChat),
      await store.resourceGrants.listForOwner(BOB, 'chat_project', PROJECT.annChat),
      await store.resourceGrants.listForOwner(BOB, 'chat', CHAT.bobShared),
    ],
  },
  {
    method: 'resourceGrants.revoke',
    name: "the owner's own grant only; returns the grantee",
    fixture,
    run: async (store) => [
      await store.resourceGrants.revoke(BOB, 'chat_project', PROJECT.annChat, uid(303)),
      await store.resourceGrants.revoke(ANN, 'chat', PROJECT.annChat, uid(303)),
      await store.resourceGrants.revoke(ANN, 'chat_project', PROJECT.annChat, uid(303)),
      await store.resourceGrants.revoke(ANN, 'chat_project', PROJECT.annChat, uid(303)),
      await store.resourceGrants.activeGrantees('chat_project', PROJECT.annChat),
    ],
  },
  {
    method: 'resourceGrants.removeGrantee',
    name: "one grantee's grant, expired or not",
    fixture,
    run: async (store) => [
      await store.resourceGrants.removeGrantee('chat_project', PROJECT.annChat, CAT),
      await store.resourceGrants.removeGrantee('chat_project', PROJECT.annChat, CAT),
      await store.resourceGrants.removeGrantee('chat', PROJECT.annChat, BOB),
      (await store.resourceGrants.listForOwner(ANN, 'chat_project', PROJECT.annChat)).map(
        (grant) => grant.granteeSubject
      ),
    ],
  },
  {
    method: 'resourceGrants.deleteForResource',
    name: 'every grant on the resource, of that kind only',
    fixture,
    run: async (store) => [
      await store.resourceGrants.deleteForResource('chat', PROJECT.annChat),
      await store.resourceGrants.deleteForResource('chat_project', PROJECT.annChat),
      await store.resourceGrants.listForOwner(ANN, 'chat_project', PROJECT.annChat),
      await store.resourceGrants.listForGrantee(ANN, 'chat'),
    ],
  },
  {
    method: 'resourceGrants.countActive',
    name: 'per resource, unexpired, empty input',
    fixture,
    run: async (store) => [
      await store.resourceGrants.countActive('chat_project', [
        PROJECT.annChat,
        PROJECT.bobChat,
        PROJECT.annCode,
      ]),
      await store.resourceGrants.countActive('chat', [CHAT.catPrivate]),
      await store.resourceGrants.countActive('chat', []),
    ],
  },
];
