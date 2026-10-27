import { defineDomain } from '../../domain';
import { memoryDelegateAccessEvents } from './memory';
import { postgresDelegateAccessEvents } from './postgres';

export const delegateAccessEvents = defineDomain({
  postgres: postgresDelegateAccessEvents,
  memory: memoryDelegateAccessEvents,
});
export type * from './types';
