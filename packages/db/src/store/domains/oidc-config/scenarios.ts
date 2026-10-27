import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const ID_A = '00000000-0000-4000-8000-0d0000000001';
const ID_B = '00000000-0000-4000-8000-0d0000000002';

const fixture = {
  oidc_config: [
    {
      id: ID_A,
      issuer: 'https://idp.example.test',
      client_id: 'renkei',
      client_secret: 'sealed-1',
      role_claim: 'roles',
      operator_idp_value: 'ops',
      user_idp_value: null,
      groups_claim: 'groups',
    },
  ],
  oidc_role_mappings: [
    { id: ID_A, idp_role: 'Admins', renkei_role: 'renkei-operator' },
    { id: ID_B, idp_role: 'admins', renkei_role: 'renkei-user' },
  ],
};

const input = (id: string, roleClaim?: string) => ({
  id,
  issuer: 'https://other.example.test',
  clientId: 'renkei-2',
  clientSecret: 'sealed-2',
  ...(roleClaim === undefined ? {} : { roleClaim }),
  operatorIdpValue: null,
  userIdpValue: 'users',
  groupsClaim: null,
});

export const oidcConfigScenarios: Scenario<DataStore>[] = [
  {
    method: 'oidcConfig.get',
    name: 'the configured row',
    fixture,
    run: async (store) => store.oidcConfig.get(),
  },
  {
    method: 'oidcConfig.get',
    name: 'nothing configured',
    run: async (store) => store.oidcConfig.get(),
  },
  {
    method: 'oidcConfig.createIfAbsent',
    name: 'first write wins',
    run: async (store) => [
      await store.oidcConfig.createIfAbsent(input(ID_A, 'roles')),
      await store.oidcConfig.createIfAbsent(input(ID_B, 'other')),
      await store.oidcConfig.get(),
    ],
  },
  {
    method: 'oidcConfig.save',
    name: 'inserts, then replaces fields; an undefined role claim keeps the stored one',
    run: async (store) => {
      await store.oidcConfig.save(input(ID_A));
      const first = await store.oidcConfig.get();
      await store.oidcConfig.save({ ...input(ID_B, 'roles'), issuer: 'https://x.example.test' });
      const second = await store.oidcConfig.get();
      await store.oidcConfig.save({ ...input(ID_B), clientSecret: 'sealed-3' });
      return [first, second, await store.oidcConfig.get()];
    },
  },
  {
    method: 'oidcConfig.updateClaims',
    name: 'replaces the mapping only; false with no row',
    fixture,
    run: async (store) => {
      const claims = {
        roleClaim: null,
        operatorIdpValue: 'operators',
        userIdpValue: 'users',
        groupsClaim: 'grp',
      };
      return [await store.oidcConfig.updateClaims(claims), await store.oidcConfig.get()];
    },
  },
  {
    method: 'oidcConfig.updateClaims',
    name: 'nothing to update',
    run: async (store) =>
      store.oidcConfig.updateClaims({
        roleClaim: 'r',
        operatorIdpValue: null,
        userIdpValue: null,
        groupsClaim: null,
      }),
  },
  {
    method: 'oidcConfig.getRoleMapping',
    name: 'exact, case-sensitive role names',
    fixture,
    run: async (store) => [
      await store.oidcConfig.getRoleMapping('Admins'),
      await store.oidcConfig.getRoleMapping('admins'),
      await store.oidcConfig.getRoleMapping('ADMINS'),
    ],
  },
  {
    method: 'oidcConfig.setRoleMapping',
    name: 'adds a role, replaces an existing one',
    fixture,
    run: async (store) => {
      await store.oidcConfig.setRoleMapping({
        id: '00000000-0000-4000-8000-0d0000000003',
        idpRole: 'Admins',
        renkeiRole: 'renkei-user',
      });
      await store.oidcConfig.setRoleMapping({
        id: '00000000-0000-4000-8000-0d0000000004',
        idpRole: 'Readers',
        renkeiRole: 'renkei-user',
      });
      return [
        await store.oidcConfig.getRoleMapping('Admins'),
        await store.oidcConfig.getRoleMapping('Readers'),
      ];
    },
  },
];
