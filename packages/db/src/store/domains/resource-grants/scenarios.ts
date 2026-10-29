import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import {
  ANN,
  BOB,
  CAT,
  CHAT,
  FUTURE,
  PAST,
  PROJECT,
  at,
  chatWorld,
  grantRow,
  uid,
} from '../chats/fixtures';

const fixture = chatWorld();

export const resourceGrantScenarios: Scenario<DataStore>[] = [
  {
    method: 'resourceGrants.ownerOf',
    name: 'per kind, missing ids',
    fixture: {
      ...fixture,
      prompt_libraries: [{ id: uid(401), owner_subject: CAT, name: 'L' }],
    },
    run: async (store) => [
      await store.resourceGrants.ownerOf('chat', CHAT.bobShared),
      await store.resourceGrants.ownerOf('chat_project', PROJECT.annChat),
      await store.resourceGrants.ownerOf('prompt_library', uid(401)),
      await store.resourceGrants.ownerOf('artifact', uid(999)),
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
  {
    method: 'resourceGrants.deleteForResources',
    name: 'every grant on the listed resources of that kind; an empty list deletes nothing',
    fixture,
    run: async (store) => [
      await store.resourceGrants.deleteForResources('chat_project', [
        PROJECT.annChat,
        PROJECT.bobChat,
        uid(999),
      ]),
      await store.resourceGrants.deleteForResources('chat', []),
      await store.resourceGrants.deleteForResources('artifact', [CHAT.bobShared]),
      await store.resourceGrants.listForGrantee(ANN, 'chat_project'),
      await store.resourceGrants.listForGrantee(ANN, 'chat'),
    ],
  },
  {
    method: 'resourceGrants.pruneOrphans',
    name: 'grants naming a missing resource go, per kind',
    fixture: {
      ...fixture,
      prompt_libraries: [{ id: uid(401), owner_subject: CAT, name: 'L' }],
      resource_access_grants: [
        ...(fixture.resource_access_grants ?? []),
        grantRow({
          id: uid(311),
          resource_kind: 'chat',
          resource_id: uid(990),
          owner_subject: ANN,
          grantee_subject: BOB,
          role: 'viewer',
          created_at: at(1),
        }),
        grantRow({
          id: uid(312),
          resource_kind: 'chat_project',
          resource_id: CHAT.annA,
          owner_subject: ANN,
          grantee_subject: BOB,
          role: 'viewer',
          created_at: at(1),
        }),
        grantRow({
          id: uid(313),
          resource_kind: 'prompt_library',
          resource_id: uid(401),
          owner_subject: CAT,
          grantee_subject: BOB,
          role: 'viewer',
          created_at: at(1),
        }),
        grantRow({
          id: uid(314),
          resource_kind: 'prompt_library',
          resource_id: uid(402),
          owner_subject: CAT,
          grantee_subject: BOB,
          role: 'viewer',
          created_at: at(1),
        }),
        grantRow({
          id: uid(315),
          resource_kind: 'artifact',
          resource_id: uid(403),
          owner_subject: CAT,
          grantee_subject: BOB,
          role: 'viewer',
          created_at: at(1),
        }),
      ],
    },
    run: async (store) => [
      await store.resourceGrants.pruneOrphans(),
      await store.resourceGrants.pruneOrphans(),
      await store.resourceGrants.listForGrantee(BOB, 'chat'),
      await store.resourceGrants.listForGrantee(BOB, 'chat_project'),
      await store.resourceGrants.listForGrantee(BOB, 'prompt_library'),
      await store.resourceGrants.listForGrantee(BOB, 'artifact'),
    ],
  },
];
