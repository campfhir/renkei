import { defineDomain } from '../../domain';
import { memorySandboxInstances } from './memory';
import { postgresSandboxInstances } from './postgres';

export const sandboxInstances = defineDomain({
  postgres: postgresSandboxInstances,
  memory: memorySandboxInstances,
});
export type * from './types';
