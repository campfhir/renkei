import { defineDomain } from '../../domain';
import { memoryResourceGrants } from './memory';
import { postgresResourceGrants } from './postgres';

export const resourceGrants = defineDomain({
  postgres: postgresResourceGrants,
  memory: memoryResourceGrants,
});
export type * from './types';
