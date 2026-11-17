import { defineDomain } from '../../domain';
import { memoryChatAgents } from './memory';
import { postgresChatAgents } from './postgres';

export const chatAgents = defineDomain({ postgres: postgresChatAgents, memory: memoryChatAgents });
export type * from './types';
