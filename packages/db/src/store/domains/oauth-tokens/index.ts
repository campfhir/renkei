import { defineDomain } from '../../domain';
import { memoryOAuthTokens } from './memory';
import { postgresOAuthTokens } from './postgres';

export const oauthTokens = defineDomain({
  postgres: postgresOAuthTokens,
  memory: memoryOAuthTokens,
});
export type * from './types';
