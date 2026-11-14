import { defineDomain } from '../../domain';
import { memorySandboxArchives } from './memory';
import { postgresSandboxArchives } from './postgres';

export const sandboxArchives = defineDomain({
  postgres: postgresSandboxArchives,
  memory: memorySandboxArchives,
});
export type * from './types';
