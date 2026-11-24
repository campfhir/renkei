import { defineDomain } from '../../domain';
import { memoryCiRepoKeys } from './memory';
import { postgresCiRepoKeys } from './postgres';

export const ciRepoKeys = defineDomain({
  postgres: postgresCiRepoKeys,
  memory: memoryCiRepoKeys,
});
export type * from './types';
