/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { batchJobScheduleScenarios } from './batch-job-schedules/scenarios';
import { batchJobScenarios } from './batch-jobs/scenarios';
import { auditEventScenarios } from './audit-events/scenarios';
import { agentDraftScenarios } from './agent-drafts/scenarios';
import { agentOptimizationScenarios } from './agent-optimizations/scenarios';
import { agentRunScenarios } from './agent-runs/scenarios';
import { agentUsageScenarios } from './agent-usage/scenarios';
import { agentScenarios } from './agents/scenarios';
import { coachMarkScenarios } from './coach-marks/scenarios';
import { eventLogScenarios } from './event-log/scenarios';
import { identityScenarios } from './identities/scenarios';
import { llmModelScenarios } from './llm-models/scenarios';
import { notificationScenarios } from './notifications/scenarios';
import { oidcConfigScenarios } from './oidc-config/scenarios';
import { orgAccessScenarios } from './org-access/scenarios';
import { scheduleCalendarScenarios } from './schedule-calendars/scenarios';
import { sessionScenarios } from './sessions/scenarios';
import { settingScenarios } from './settings/scenarios';
import { usageScenarios } from './usage/scenarios';
import { userPreferenceScenarios } from './user-preferences/scenarios';
import { salesforceChangeScenarios } from './salesforce-changes/scenarios';
import { jiraChangeScenarios } from './jira-changes/scenarios';
import { jiraSpaceTemplateScenarios } from './jira-space-templates/scenarios';
import { adminChangeQueueScenarios } from './admin-change-queue/scenarios';
import { salesforceGrantScenarios } from './salesforce-grants/scenarios';
import { connectorConfigScenarios } from './connector-configs/scenarios';
import { providerGrantScenarios } from './provider-grants/scenarios';
import { mcpServerScenarios } from './mcp-servers/scenarios';
import { fileShareScenarios } from './file-shares/scenarios';
import { mirthInstanceScenarios } from './mirth-instances/scenarios';
import { adManagerInstanceScenarios } from './admanager-instances/scenarios';
import { emailSanitizerScenarios } from './email-sanitizer/scenarios';
import { mailReviewScenarios } from './mail-review/scenarios';
import { resourceGrantScenarios } from './resource-grants/scenarios';
import { chatScenarios } from './chats/scenarios';
import { chatThreadScenarios } from './chat-threads/scenarios';
import { chatProjectScenarios } from './chat-projects/scenarios';
import { promptLibraryScenarios } from './prompt-libraries/scenarios';
import { userMemoryScenarios } from './user-memory/scenarios';
import { artifactScenarios } from './artifacts/scenarios';
import { codeProjectScenarios } from './code-projects/scenarios';
import { codeTemplateScenarios } from './code-templates/scenarios';
import { chatModelScenarios } from './chat-models/scenarios';
import { actionableItemScenarios } from './actionable-items/scenarios';
import { firstRunScenarios } from './first-run/scenarios';
import { oauthConsentScenarios } from './oauth-consents/scenarios';
import { deviceKeyRequestScenarios } from './device-key-requests/scenarios';
import { personalAccountScenarios } from './personal-account/scenarios';
import { activityLogScenarios } from './activity-logs/scenarios';
import { toolUsageScenarios } from './tool-usage/scenarios';
import { knowledgeChunkScenarios } from './knowledge-chunks/scenarios';
import { uploadSlotScenarios } from './upload-slots/scenarios';
import { chatTurnEngineScenarios } from './chat-threads/engine-scenarios';

import { pendingSigninScenarios } from './pending-signins/scenarios';
import { webhookSubscriptionScenarios } from './webhook-subscriptions/scenarios';
export const SCENARIOS: Scenario<DataStore>[] = [
  ...sessionScenarios,
  ...identityScenarios,
  ...userPreferenceScenarios,
  ...settingScenarios,
  ...coachMarkScenarios,
  ...notificationScenarios,
  ...salesforceChangeScenarios,
  ...jiraChangeScenarios,
  ...jiraSpaceTemplateScenarios,
  ...adminChangeQueueScenarios,
  ...salesforceGrantScenarios,
  ...batchJobScenarios,
  ...batchJobScheduleScenarios,
  ...auditEventScenarios,
  ...eventLogScenarios,
  ...oidcConfigScenarios,
  ...llmModelScenarios,
  ...scheduleCalendarScenarios,
  ...orgAccessScenarios,
  ...usageScenarios,
  ...agentScenarios,
  ...agentRunScenarios,
  ...agentUsageScenarios,
  ...agentOptimizationScenarios,
  ...agentDraftScenarios,
  ...connectorConfigScenarios,
  ...providerGrantScenarios,
  ...mcpServerScenarios,
  ...fileShareScenarios,
  ...mirthInstanceScenarios,
  ...adManagerInstanceScenarios,
  ...emailSanitizerScenarios,
  ...mailReviewScenarios,
  ...resourceGrantScenarios,
  ...chatScenarios,
  ...chatThreadScenarios,
  ...chatProjectScenarios,
  ...promptLibraryScenarios,
  ...userMemoryScenarios,
  ...artifactScenarios,
  ...codeProjectScenarios,
  ...codeTemplateScenarios,
  ...chatModelScenarios,
  ...actionableItemScenarios,
  ...firstRunScenarios,
  ...oauthConsentScenarios,
  ...deviceKeyRequestScenarios,
  ...personalAccountScenarios,
  ...activityLogScenarios,
  ...toolUsageScenarios,
  ...knowledgeChunkScenarios,
  ...pendingSigninScenarios,
  ...webhookSubscriptionScenarios,
  ...uploadSlotScenarios,
  ...chatTurnEngineScenarios,
];
