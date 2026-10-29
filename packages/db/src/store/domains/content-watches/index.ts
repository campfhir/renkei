import { defineDomain } from '../../domain';
import { memoryContentWatches } from './memory';
import { postgresContentWatches } from './postgres';

export const contentWatches = defineDomain({
  postgres: postgresContentWatches,
  memory: memoryContentWatches,
});
export type * from './types';
