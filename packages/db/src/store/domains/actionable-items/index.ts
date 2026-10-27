import { defineDomain } from '../../domain';
import { memoryActionableItems } from './memory';
import { postgresActionableItems } from './postgres';

export const actionableItems = defineDomain({
  postgres: postgresActionableItems,
  memory: memoryActionableItems,
});
export type * from './types';
