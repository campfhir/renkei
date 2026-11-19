import { defineDomain } from '../../domain';
import { memoryCiAssistantJobs } from './memory';
import { postgresCiAssistantJobs } from './postgres';

export const ciAssistantJobs = defineDomain({
  postgres: postgresCiAssistantJobs,
  memory: memoryCiAssistantJobs,
});
export type * from './types';
