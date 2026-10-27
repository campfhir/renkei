import { defineDomain } from '../../domain';
import { memoryPendingSignins } from './memory';
import { postgresPendingSignins } from './postgres';

export const pendingSignins = defineDomain({
  postgres: postgresPendingSignins,
  memory: memoryPendingSignins,
});
export type * from './types';
