import { defineDomain } from '../../domain';
import { memoryCiHealth } from './memory';
import { postgresCiHealth } from './postgres';

export const ciHealth = defineDomain({
  postgres: postgresCiHealth,
  memory: memoryCiHealth,
});
export type * from './types';
