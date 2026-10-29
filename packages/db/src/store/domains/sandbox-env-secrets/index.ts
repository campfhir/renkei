import { defineDomain } from '../../domain';
import { memorySandboxEnvSecrets } from './memory';
import { postgresSandboxEnvSecrets } from './postgres';

export const sandboxEnvSecrets = defineDomain({
  postgres: postgresSandboxEnvSecrets,
  memory: memorySandboxEnvSecrets,
});
export type * from './types';
