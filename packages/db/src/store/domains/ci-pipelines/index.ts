import { defineDomain } from '../../domain';
import { memoryCiPipelines } from './memory';
import { postgresCiPipelines } from './postgres';

export const ciPipelines = defineDomain({
  postgres: postgresCiPipelines,
  memory: memoryCiPipelines,
});
export type * from './types';
