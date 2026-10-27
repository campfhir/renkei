import { defineDomain } from '../../domain';
import { memoryScheduleCalendars } from './memory';
import { postgresScheduleCalendars } from './postgres';

export const scheduleCalendars = defineDomain({
  postgres: postgresScheduleCalendars,
  memory: memoryScheduleCalendars,
});
export type * from './types';
