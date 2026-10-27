import { defineDomain } from '../../domain';
import { memoryUsageLedgers } from './memory';
import { postgresUsageLedgers } from './postgres';

export const usageLedgers = defineDomain({
  postgres: postgresUsageLedgers,
  memory: memoryUsageLedgers,
});
export type * from './types';
