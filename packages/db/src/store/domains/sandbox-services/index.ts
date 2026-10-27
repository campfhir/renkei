import { defineDomain } from '../../domain';
import { memorySandboxServices } from './memory';
import { postgresSandboxServices } from './postgres';

export const sandboxServices = defineDomain({
  postgres: postgresSandboxServices,
  memory: memorySandboxServices,
});
export type * from './types';
