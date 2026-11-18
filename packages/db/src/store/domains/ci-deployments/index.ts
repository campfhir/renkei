import { defineDomain } from '../../domain';
import { memoryCiDeployments } from './memory';
import { postgresCiDeployments } from './postgres';

export const ciDeployments = defineDomain({
  postgres: postgresCiDeployments,
  memory: memoryCiDeployments,
});
export type * from './types';
