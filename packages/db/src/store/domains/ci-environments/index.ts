import { defineDomain } from '../../domain';
import { memoryCiEnvironments } from './memory';
import { postgresCiEnvironments } from './postgres';

export const ciEnvironments = defineDomain({
  postgres: postgresCiEnvironments,
  memory: memoryCiEnvironments,
});
export type * from './types';
