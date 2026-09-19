'use server';

/**
 * Organization Usage's report — the operator's tenant-wide counterpart to
 * "My usage", and, with a subject, the same report for one person along
 * with who that person is (the old People page, folded in here). Gated on
 * ROLE_OPERATOR on every call, the same way every other admin action in
 * this app is: a page-level check is not enough on its own, because a
 * server action is reachable on its own.
 */

import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { safeTimeZone } from '../../usage/window';
import {
  getMostEfficientAgents,
  getOrgActivityTotals,
  getOrgDailySeries,
  getSurfaceTokenTotals,
  getTokensByModel,
  getTopAgentsByTokens,
  getTopToolsOrg,
  getTopUsers,
  listPeople,
  type EfficientAgentRow,
  type ModelTokenRow,
  type OrgActivityTotals,
  type OrgTokenTotals,
  type OrgToolRow,
  type PersonOption,
  type TopAgentRow,
} from '@/lib/usage/org-usage';
import { getPersonProfile, type PersonProfile } from '@/lib/usage/person-profile';
import {
  getVoiceTotals,
  getVoiceUsers,
  ZERO_VOICE_TOTALS,
  type VoiceTotals,
} from '@/lib/usage/voice-usage';
import { rankVoiceUsers, type RankedVoiceUserRow } from '@/lib/usage/voice-window';
import {
  activityCells,
  bucketOrgSeries,
  rankUsers,
  resolvePeriod,
  seriesGranularity,
  type ActivityCell,
  type OrgBucket,
  type RankedUserRow,
} from './window';

/** How many people the leaderboard names before the selected person's own rank. */
const TOP_USERS = 5;

export interface OrgUsageReport {
  periodKey: string;
  days: number;
  /** The IANA zone every day in the report is bucketed in. */
  timeZone: string;
  /** The person every figure below is scoped to, or null for the whole org. */
  subject: string | null;
  /** Who that person is — null org-wide, or when nothing at all is known about the subject. */
  person: PersonProfile | null;
  /** Everyone who has signed in, for the picker. */
  people: PersonOption[];
  tokens: OrgTokenTotals;
  activity: OrgActivityTotals;
  series: OrgBucket[];
  /** One square per day (or hour) of the window, for the activity calendar. */
  cells: ActivityCell[];
  byModel: ModelTokenRow[];
  topUsers: RankedUserRow[];
  /** The selected person's own row and rank, when they spent anything in the window. */
  selectedUser: RankedUserRow | null;
  includeAgentsInTopUsers: boolean;
  topAgents: TopAgentRow[];
  efficientAgents: EfficientAgentRow[];
  topTools: OrgToolRow[];
  /** Voice over the window, scoped like the tokens. */
  voice: VoiceTotals;
  /** Who is read to the most (text to speech, by the character), and the selected person's rank. */
  topListeners: RankedVoiceUserRow[];
  selectedListener: RankedVoiceUserRow | null;
  /** Who talks to the chat the most (speech to text, by the second), and the selected person's rank. */
  topSpeakers: RankedVoiceUserRow[];
  selectedSpeaker: RankedVoiceUserRow | null;
  error?: string;
  signedOut?: boolean;
  forbidden?: boolean;
}

const ZERO_TOKENS: OrgTokenTotals = {
  chat: { input: 0, output: 0 },
  chatProjects: { input: 0, output: 0 },
  codeProjects: { input: 0, output: 0 },
  agents: { input: 0, output: 0 },
};

const ZERO_ACTIVITY: OrgActivityTotals = {
  runs: 0,
  failures: 0,
  toolCalls: 0,
  toolErrors: 0,
  activeUsers: 0,
  totalUsers: 0,
};

export async function getOrgUsageReport(
  tenantId: string,
  requestedPeriod?: string,
  requestedTimeZone?: string,
  includeAgentsInTopUsers = false,
  requestedSubject: string | null = null
): Promise<OrgUsageReport> {
  const period = resolvePeriod(requestedPeriod);
  const timeZone = safeTimeZone(requestedTimeZone);
  const subject = requestedSubject?.trim() ? requestedSubject.trim() : null;
  const empty: OrgUsageReport = {
    periodKey: period.key,
    days: period.days,
    timeZone,
    subject,
    person: null,
    people: [],
    tokens: ZERO_TOKENS,
    activity: ZERO_ACTIVITY,
    series: [],
    cells: [],
    byModel: [],
    topUsers: [],
    selectedUser: null,
    includeAgentsInTopUsers,
    topAgents: [],
    efficientAgents: [],
    topTools: [],
    voice: ZERO_VOICE_TOTALS,
    topListeners: [],
    selectedListener: null,
    topSpeakers: [],
    selectedSpeaker: null,
  };

  const session = await getSessionFromCookies(tenantId);
  if (!session) return { ...empty, error: 'Sign in to see organization usage', signedOut: true };
  if (!(await checkAccess(tenantId, [ROLE_OPERATOR]))) {
    return { ...empty, error: 'Operator access required', forbidden: true };
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return { ...empty, error: 'Database unavailable' };
  const db = dbResult.val;

  try {
    const [
      tokens,
      activity,
      daily,
      allUsers,
      topAgents,
      efficientAgents,
      topTools,
      byModel,
      people,
      person,
      voice,
      voiceUsers,
    ] = await Promise.all([
      getSurfaceTokenTotals(db, tenantId, period, timeZone, subject),
      getOrgActivityTotals(db, tenantId, period, timeZone, subject),
      getOrgDailySeries(db, tenantId, period, timeZone, subject, seriesGranularity(period.days)),
      // Every spender, ranked: the top few are shown, and the selected
      // person's own rank is read off the same list.
      getTopUsers(db, tenantId, period, timeZone, includeAgentsInTopUsers),
      getTopAgentsByTokens(db, tenantId, period, timeZone, subject),
      getMostEfficientAgents(db, tenantId, period, timeZone, 10, 3, subject),
      getTopToolsOrg(db, tenantId, period, timeZone, subject),
      getTokensByModel(db, tenantId, period, timeZone, subject),
      listPeople(db, tenantId),
      subject === null ? Promise.resolve(null) : getPersonProfile(db, tenantId, subject),
      getVoiceTotals(db, tenantId, period, timeZone, subject),
      getVoiceUsers(db, tenantId, period, timeZone),
    ]);
    const now = new Date();
    const ranked = rankUsers(allUsers, subject, TOP_USERS);
    const listeners = rankVoiceUsers(voiceUsers, 'speech', subject, TOP_USERS);
    const speakers = rankVoiceUsers(voiceUsers, 'transcription', subject, TOP_USERS);
    return {
      periodKey: period.key,
      days: period.days,
      timeZone,
      subject,
      person,
      people,
      tokens,
      activity,
      series: bucketOrgSeries(daily, period, now, timeZone),
      cells: activityCells(daily, period, now, timeZone),
      byModel,
      topUsers: ranked.top,
      selectedUser: ranked.selected,
      includeAgentsInTopUsers,
      topAgents,
      efficientAgents,
      topTools,
      voice,
      topListeners: listeners.top,
      selectedListener: listeners.selected,
      topSpeakers: speakers.top,
      selectedSpeaker: speakers.selected,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : 'Could not read usage' };
  }
}
