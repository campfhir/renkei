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
import { resourceGrants } from './resource-grants';
import { chats } from './chats';
import { chatThreads } from './chat-threads';
import { chatProjects } from './chat-projects';
import { promptLibraries } from './prompt-libraries';
import { userMemory } from './user-memory';
import { artifacts } from './artifacts';
import { codeProjects } from './code-projects';
import { codeTemplates } from './code-templates';
import { chatModels } from './chat-models';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
  resourceGrants,
  chats,
  chatThreads,
  chatProjects,
  promptLibraries,
  userMemory,
  artifacts,
  codeProjects,
  codeTemplates,
  chatModels,
};
