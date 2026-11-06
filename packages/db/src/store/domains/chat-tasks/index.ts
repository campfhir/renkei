import { defineDomain } from '../../domain';
import { memoryChatTasks } from './memory';
import { postgresChatTasks } from './postgres';

export const chatTasks = defineDomain({
  postgres: postgresChatTasks,
  memory: memoryChatTasks,
});
export type * from './types';
