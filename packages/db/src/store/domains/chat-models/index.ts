import { defineDomain } from '../../domain';
import { memoryChatModels } from './memory';
import { postgresChatModels } from './postgres';

export const chatModels = defineDomain({
  postgres: postgresChatModels,
  memory: memoryChatModels,
});
export type * from './types';
