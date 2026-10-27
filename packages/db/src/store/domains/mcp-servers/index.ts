import { defineDomain } from '../../domain';
import { memoryMcpServers } from './memory';
import { postgresMcpServers } from './postgres';

export const mcpServers = defineDomain({
  postgres: postgresMcpServers,
  memory: memoryMcpServers,
});
export type * from './types';
