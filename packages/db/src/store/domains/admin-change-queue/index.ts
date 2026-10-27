import { defineDomain } from '../../domain';
import { memoryAdminChangeQueue } from './memory';
import { postgresAdminChangeQueue } from './postgres';

export const adminChangeQueue = defineDomain({
  postgres: postgresAdminChangeQueue,
  memory: memoryAdminChangeQueue,
});
export type * from './types';
