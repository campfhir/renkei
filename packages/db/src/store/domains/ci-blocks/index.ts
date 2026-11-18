import { defineDomain } from '../../domain';
import { memoryCiBlocks } from './memory';
import { postgresCiBlocks } from './postgres';

export const ciBlocks = defineDomain({
  postgres: postgresCiBlocks,
  memory: memoryCiBlocks,
});
export type * from './types';
