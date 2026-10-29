import { defineDomain } from '../../domain';
import { memoryUserMemory } from './memory';
import { postgresUserMemory } from './postgres';

export const userMemory = defineDomain({
  postgres: postgresUserMemory,
  memory: memoryUserMemory,
});
export type * from './types';
