import { defineDomain } from '../../domain';
import { memorySandboxFiles } from './memory';
import { postgresSandboxFiles } from './postgres';

export const sandboxFiles = defineDomain({
  postgres: postgresSandboxFiles,
  memory: memorySandboxFiles,
});
export type * from './types';
