/**
 * Every area of the data store, by the key callers reach it under:
 * `getDataStore().<key>`. Adding an area is a folder beside these (see
 * ../domain.ts) and one line here and one in ./scenarios.ts.
 */

import { batchJobSchedules } from './batch-job-schedules';
import { batchJobs } from './batch-jobs';
import { auditEvents } from './audit-events';
import { agentDrafts } from './agent-drafts';
import { agentOptimizations } from './agent-optimizations';
import { agentRuns } from './agent-runs';
import { agentUsage } from './agent-usage';
import { agents } from './agents';
import { coachMarks } from './coach-marks';
import { eventLog } from './event-log';
import { identities } from './identities';
import { llmModels } from './llm-models';
import { notifications } from './notifications';
import { oidcConfig } from './oidc-config';
import { orgAccess } from './org-access';
import { scheduleCalendars } from './schedule-calendars';
import { sessions } from './sessions';
import { settings } from './settings';
import { usage } from './usage';
import { userPreferences } from './user-preferences';
import { salesforceChanges } from './salesforce-changes';
import { jiraChanges } from './jira-changes';
import { jiraSpaceTemplates } from './jira-space-templates';
import { adminChangeQueue } from './admin-change-queue';
import { salesforceGrants } from './salesforce-grants';
import { connectorConfigs } from './connector-configs';
import { providerGrants } from './provider-grants';
import { mcpServers } from './mcp-servers';
import { fileShares } from './file-shares';
import { mirthInstances } from './mirth-instances';
import { adManagerInstances } from './admanager-instances';
import { emailSanitizer } from './email-sanitizer';
import { mailReview } from './mail-review';
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
import { actionableItems } from './actionable-items';
import { firstRun } from './first-run';
import { oauthConsents } from './oauth-consents';
import { deviceKeyRequests } from './device-key-requests';
import { personalAccount } from './personal-account';
import { activityLogs } from './activity-logs';
import { toolUsage } from './tool-usage';
import { knowledgeChunks } from './knowledge-chunks';
import { pendingSignins } from './pending-signins';
import { webhookSubscriptions } from './webhook-subscriptions';
import { uploadSlots } from './upload-slots';
import { platformSettings } from './platform-settings';
import { userKeys } from './user-keys';
import { queues } from './queues';
import { runTokens } from './run-tokens';
import { knowledgeReindexRuns } from './knowledge-reindex-runs';
import { oauthTokens } from './oauth-tokens';
import { phiAccess } from './phi-access';
import { mailBulkJobs } from './mail-bulk-jobs';
import { webexSentMessages } from './webex-sent-messages';
import { toolSurface } from './tool-surface';
import { contentWatches } from './content-watches';
import { advisoryLocks } from './advisory-locks';
import { agentTriggerFirings } from './agent-trigger-firings';
import { webexDirtyWindows } from './webex-dirty-windows';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
  salesforceChanges,
  jiraChanges,
  jiraSpaceTemplates,
  adminChangeQueue,
  salesforceGrants,
  batchJobs,
  batchJobSchedules,
  auditEvents,
  eventLog,
  oidcConfig,
  llmModels,
  scheduleCalendars,
  orgAccess,
  usage,
  agents,
  agentRuns,
  agentUsage,
  agentOptimizations,
  agentDrafts,
  connectorConfigs,
  providerGrants,
  mcpServers,
  fileShares,
  mirthInstances,
  adManagerInstances,
  emailSanitizer,
  mailReview,
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
  actionableItems,
  firstRun,
  oauthConsents,
  deviceKeyRequests,
  personalAccount,
  activityLogs,
  toolUsage,
  knowledgeChunks,
  pendingSignins,
  webhookSubscriptions,
  uploadSlots,
  platformSettings,
  userKeys,
  queues,
  runTokens,
  knowledgeReindexRuns,
  oauthTokens,
  phiAccess,
  mailBulkJobs,
  webexSentMessages,
  toolSurface,
  contentWatches,
  advisoryLocks,
  agentTriggerFirings,
  webexDirtyWindows,
};
