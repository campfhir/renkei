import { defineDomain } from '../../domain';
import { memoryFileShares } from './memory';
import { postgresFileShares } from './postgres';

export const fileShares = defineDomain({
  postgres: postgresFileShares,
  memory: memoryFileShares,
});
export type * from './types';
