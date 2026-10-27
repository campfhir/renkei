/**
 * Every area of the data store, by the key callers reach it under:
 * `getDataStore().<key>`. Adding an area is a folder beside these (see
 * ../domain.ts) and one line here and one in ./scenarios.ts.
 */

import { coachMarks } from './coach-marks';
import { identities } from './identities';
import { notifications } from './notifications';
import { sessions } from './sessions';
import { settings } from './settings';
import { userPreferences } from './user-preferences';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
};
