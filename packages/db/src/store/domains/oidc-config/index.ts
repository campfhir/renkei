import { defineDomain } from '../../domain';
import { memoryOidcConfig } from './memory';
import { postgresOidcConfig } from './postgres';

export const oidcConfig = defineDomain({ postgres: postgresOidcConfig, memory: memoryOidcConfig });
export type * from './types';
