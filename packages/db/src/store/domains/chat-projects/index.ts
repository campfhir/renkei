import { defineDomain } from '../../domain';
import { memoryChatProjects } from './memory';
import { postgresChatProjects } from './postgres';

export const chatProjects = defineDomain({
  postgres: postgresChatProjects,
  memory: memoryChatProjects,
});
export type * from './types';
