import { defineDomain } from '../../domain';
import { memoryPersonalAccount } from './memory';
import { postgresPersonalAccount } from './postgres';

export const personalAccount = defineDomain({
  postgres: postgresPersonalAccount,
  memory: memoryPersonalAccount,
});
export type * from './types';
