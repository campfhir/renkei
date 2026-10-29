import { defineDomain } from '../../domain';
import { memorySessions } from './memory';
import { postgresSessions } from './postgres';

export const sessions = defineDomain({ postgres: postgresSessions, memory: memorySessions });
export type * from './types';
