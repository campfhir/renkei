import { defineDomain } from '../../domain';
import { memoryCodeServiceImageRules } from './memory';
import { postgresCodeServiceImageRules } from './postgres';

export const codeServiceImageRules = defineDomain({
  postgres: postgresCodeServiceImageRules,
  memory: memoryCodeServiceImageRules,
});
export type * from './types';
