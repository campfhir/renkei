import { defineDomain } from '../../domain';
import { memoryUserPreferences } from './memory';
import { postgresUserPreferences } from './postgres';

export const userPreferences = defineDomain({
  postgres: postgresUserPreferences,
  memory: memoryUserPreferences,
});
export type * from './types';
