import { defineDomain } from '../../domain';
import { memoryUserKeys } from './memory';
import { postgresUserKeys } from './postgres';

export const userKeys = defineDomain({
  postgres: postgresUserKeys,
  memory: memoryUserKeys,
});
export type * from './types';
