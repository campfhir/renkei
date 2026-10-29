import { defineDomain } from '../../domain';
import { memoryChatThreads } from './memory';
import { postgresChatThreads } from './postgres';

export const chatThreads = defineDomain({
  postgres: postgresChatThreads,
  memory: memoryChatThreads,
});
export type * from './types';
