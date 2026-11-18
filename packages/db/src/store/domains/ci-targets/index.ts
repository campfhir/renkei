import { defineDomain } from '../../domain';
import { memoryCiTargets } from './memory';
import { postgresCiTargets } from './postgres';

export const ciTargets = defineDomain({
  postgres: postgresCiTargets,
  memory: memoryCiTargets,
});
export type * from './types';
