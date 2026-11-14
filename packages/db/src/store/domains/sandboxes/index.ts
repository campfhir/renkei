import { defineDomain } from '../../domain';
import { memorySandboxes } from './memory';
import { postgresSandboxes } from './postgres';

export const sandboxes = defineDomain({
  postgres: postgresSandboxes,
  memory: memorySandboxes,
});
export type * from './types';
