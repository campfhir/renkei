import { defineDomain } from '../../domain';
import { memorySandboxWorkspaces } from './memory';
import { postgresSandboxWorkspaces } from './postgres';

export const sandboxWorkspaces = defineDomain({
  postgres: postgresSandboxWorkspaces,
  memory: memorySandboxWorkspaces,
});
export type * from './types';
