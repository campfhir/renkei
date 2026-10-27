import { defineDomain } from '../../domain';
import { memoryMirthInstances } from './memory';
import { postgresMirthInstances } from './postgres';

export const mirthInstances = defineDomain({
  postgres: postgresMirthInstances,
  memory: memoryMirthInstances,
});
export type * from './types';
