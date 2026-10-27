import { defineDomain } from '../../domain';
import { memoryResourceKeys } from './memory';
import { postgresResourceKeys } from './postgres';

export const resourceKeys = defineDomain({
  postgres: postgresResourceKeys,
  memory: memoryResourceKeys,
});
export type * from './types';
