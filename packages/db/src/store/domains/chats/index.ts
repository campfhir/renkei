import { defineDomain } from '../../domain';
import { memoryChats } from './memory';
import { postgresChats } from './postgres';

export const chats = defineDomain({
  postgres: postgresChats,
  memory: memoryChats,
});
export type * from './types';
