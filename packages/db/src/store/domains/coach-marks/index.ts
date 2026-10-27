import { defineDomain } from '../../domain';
import { memoryCoachMarks } from './memory';
import { postgresCoachMarks } from './postgres';

export const coachMarks = defineDomain({ postgres: postgresCoachMarks, memory: memoryCoachMarks });
export type * from './types';
