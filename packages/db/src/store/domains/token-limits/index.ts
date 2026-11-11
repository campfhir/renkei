import { defineDomain } from '../../domain';
import { memoryTokenLimits } from './memory';
import { postgresTokenLimits } from './postgres';

export const tokenLimits = defineDomain({
  postgres: postgresTokenLimits,
  memory: memoryTokenLimits,
});
export type * from './types';
