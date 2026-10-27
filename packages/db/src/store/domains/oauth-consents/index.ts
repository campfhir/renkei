import { defineDomain } from '../../domain';
import { memoryOAuthConsents } from './memory';
import { postgresOAuthConsents } from './postgres';

export const oauthConsents = defineDomain({
  postgres: postgresOAuthConsents,
  memory: memoryOAuthConsents,
});
export type * from './types';
