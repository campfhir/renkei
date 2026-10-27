import { defineDomain } from '../../domain';
import { memoryNotifications } from './memory';
import { postgresNotifications } from './postgres';

export const notifications = defineDomain({
  postgres: postgresNotifications,
  memory: memoryNotifications,
});
export type * from './types';
