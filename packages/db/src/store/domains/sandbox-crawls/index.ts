import { defineDomain } from '../../domain';
import { memorySandboxCrawls } from './memory';
import { postgresSandboxCrawls } from './postgres';

export const sandboxCrawls = defineDomain({
  postgres: postgresSandboxCrawls,
  memory: memorySandboxCrawls,
});
export type * from './types';
