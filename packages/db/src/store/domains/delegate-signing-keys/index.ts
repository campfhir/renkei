import { defineDomain } from '../../domain';
import { memoryDelegateSigningKeys } from './memory';
import { postgresDelegateSigningKeys } from './postgres';

export const delegateSigningKeys = defineDomain({
  postgres: postgresDelegateSigningKeys,
  memory: memoryDelegateSigningKeys,
});
export type * from './types';
