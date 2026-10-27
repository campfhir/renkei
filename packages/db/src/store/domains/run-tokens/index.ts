import { defineDomain } from '../../domain';
import { memoryRunTokens } from './memory';
import { postgresRunTokens } from './postgres';

export const runTokens = defineDomain({
  postgres: postgresRunTokens,
  memory: memoryRunTokens,
});
export type * from './types';
