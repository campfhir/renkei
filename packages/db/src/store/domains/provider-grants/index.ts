import { defineDomain } from '../../domain';
import { memoryProviderGrants } from './memory';
import { postgresProviderGrants } from './postgres';

export const providerGrants = defineDomain({
  postgres: postgresProviderGrants,
  memory: memoryProviderGrants,
});
export type * from './types';
