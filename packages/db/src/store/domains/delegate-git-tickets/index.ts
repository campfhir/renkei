import { defineDomain } from '../../domain';
import { memoryDelegateGitTickets } from './memory';
import { postgresDelegateGitTickets } from './postgres';

export const delegateGitTickets = defineDomain({
  postgres: postgresDelegateGitTickets,
  memory: memoryDelegateGitTickets,
});
export type * from './types';
