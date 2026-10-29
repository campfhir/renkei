import { defineDomain } from '../../domain';
import { memorySandboxSecrets } from './memory';
import { postgresSandboxSecrets } from './postgres';

export const sandboxSecrets = defineDomain({
  postgres: postgresSandboxSecrets,
  memory: memorySandboxSecrets,
});
export type * from './types';
