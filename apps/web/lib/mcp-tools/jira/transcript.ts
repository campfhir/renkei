/**
 * Meeting transcript -> recommended Jira tool calls.
 *
 * Pattern matching, not comprehension: the point is to surface the handful of
 * sentences that look actionable and pre-fill the arguments, so a human or a
 * model can confirm them. Nothing here executes anything.
 *
 * Recommendations name the tools this server actually exposes, with arguments
 * in the shape those tools accept — a suggestion the caller cannot execute
 * verbatim is worse than no suggestion, because it reads as though it works.
 * What a meeting asks for but no tool can do is reported separately, as an
 * observation, rather than dressed up as a call.
 *
 * The kind of meeting changes what a sentence probably means. A standup talks
 * about issues that already exist, so "we should add a task" there is more
 * likely an aside than an instruction; planning assigns points and pulls from
 * the backlog; a retro reviews work already done. The type is inferred from
 * what was said, with duration as a tie-breaker, and shifts confidence rather
 * than filtering — a misread meeting should cost certainty, not content.
 */

export interface RecommendedAction {
  confidence: 'high' | 'medium' | 'low';
  tool: string;
  summary: string;
  arguments: Record<string, unknown>;
  excerpt: string;
}

/**
 * An action plus where in the transcript it came from. Patterns overlap — "we
 * need to create a bug for X" matches two of them — so the span is what lets
 * the near-duplicate be recognised as one observation.
 */
interface Candidate extends RecommendedAction {
  span: readonly [number, number];
  /**
   * Which meetings this reading belongs in, when the tool alone does not say.
   * Assignment and estimation both call jira_update_issue but fit different rooms.
   */
  fit?: MeetingType[];
}

/** The meeting shapes this distinguishes. */
export const MEETING_TYPES = ['standup', 'sprint-planning', 'retro', 'ad-hoc'] as const;

export type MeetingType = (typeof MEETING_TYPES)[number];

/** Narrow an argument that arrived from a tool call. */
export function isMeetingType(value: unknown): value is MeetingType {
  return typeof value === 'string' && MEETING_TYPES.some((type) => type === value);
}

export interface MeetingContext {
  type: MeetingType;
  /** Whether the caller stated the type or it was read off the transcript. */
  source: 'stated' | 'inferred';
  /** The phrases that decided it, so a human can see it was read wrong. */
  signals: string[];
}

export interface TranscriptAnalysis {
  meeting: MeetingContext;
  actions: RecommendedAction[];
}

export interface TranscriptOptions {
  /** Default project for created issues. */
  projectKey?: string | undefined;
  /** The issue under discussion, used to resolve "this", "it" and "that". */
  issueKey?: string | undefined;
  /** Skip inference when the caller already knows what meeting this was. */
  meetingType?: MeetingType | undefined;
  /** Tie-breaker only: a 10-minute meeting is a standup, a 90-minute one is not. */
  durationMinutes?: number | undefined;
  /** Target sprint for "pull it into the sprint", which otherwise needs a lookup. */
  sprintId?: string | undefined;
}

/** Jira issue keys: uppercase project key, dash, number. */
const ISSUE_KEY = '[A-Z][A-Z0-9_]*-\\d+';
/** An issue named outright, or referred to by pronoun. */
const TARGET = `(${ISSUE_KEY}|this|it|that)`;

const PRONOUNS = new Set(['this', 'it', 'that']);

const EXCERPT_LENGTH = 120;

/**
 * A spoken duration. Longest unit first: an alternation that offers `d` before
 * `days` matches just the `d` and truncates the capture to "3 d".
 */
const DURATION = '(\\d+(?:\\.\\d+)?\\s*(?:minutes?|mins?|hours?|hrs?|weeks?|days?|m|h|d|w))';

/**
 * Statuses worth normalising. Anything else is passed through as written and
 * marked low confidence — `jira_transition_issue` matches on name and reports the
 * available ones, so a near miss self-corrects on the next call.
 */
const STATUS_NAMES: Record<string, string> = {
  todo: 'To Do',
  'to do': 'To Do',
  'to-do': 'To Do',
  backlog: 'Backlog',
  'in progress': 'In Progress',
  'in-progress': 'In Progress',
  inprogress: 'In Progress',
  started: 'In Progress',
  'in review': 'In Review',
  'code review': 'In Review',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  complete: 'Done',
  completed: 'Done',
  closed: 'Done',
  resolved: 'Done',
};

/** The noun used in the sentence, mapped to a Jira issue type. */
const ISSUE_TYPES: Record<string, string> = {
  issue: 'Task',
  task: 'Task',
  bug: 'Bug',
  story: 'Story',
};

/**
 * Phrases that identify a meeting. Weighted because some are decisive on their
 * own — nobody says "retrospective" in a standup — while others only lean.
 */
const MEETING_SIGNALS: Record<Exclude<MeetingType, 'ad-hoc'>, [RegExp, number][]> = {
  standup: [
    [/\bstand-?up\b/i, 5],
    [/\bdaily\b/i, 2],
    [/\byesterday I\b/i, 3],
    [/\btoday I(?:'ll| will| am)?\b/i, 3],
    [/\bblock(?:ed|er)\b/i, 2],
    [/\bworking on\b/i, 1],
    [/\bno blockers\b/i, 3],
  ],
  'sprint-planning': [
    [/\bsprint planning\b/i, 5],
    [/\bplanning (?:meeting|session)\b/i, 4],
    [/\bstory points?\b/i, 4],
    [/\bpoints?\b/i, 1],
    [/\bbacklog\b/i, 3],
    [/\bsprint goal\b/i, 3],
    [/\bcapacity\b/i, 2],
    [/\bvelocity\b/i, 2],
    [/\bgroom(?:ing)?\b|\brefin(?:e|ement)\b/i, 2],
    [/\bestimate[sd]?\b/i, 2],
  ],
  retro: [
    [/\bretro(?:spective)?\b/i, 5],
    [/\bwent well\b/i, 4],
    [/\bdid ?n[o']t go well\b/i, 4],
    [/\bdo better\b/i, 3],
    [/\bwhat worked\b/i, 3],
    [/\blessons? learned\b/i, 3],
    [/\blast sprint\b/i, 1],
  ],
};

/** The types worth scoring; ad-hoc is what nothing else matching means. */
const SCORED_TYPES: Exclude<MeetingType, 'ad-hoc'>[] = ['standup', 'sprint-planning', 'retro'];

/** Where each type's duration sits, used only to break a scoring tie. */
const DURATION_HINTS: [Exclude<MeetingType, 'ad-hoc'>, (minutes: number) => boolean][] = [
  ['standup', (minutes) => minutes <= 20],
  ['retro', (minutes) => minutes > 20 && minutes <= 75],
  ['sprint-planning', (minutes) => minutes > 45],
];

export function detectMeeting(transcript: string, options: TranscriptOptions = {}): MeetingContext {
  if (options.meetingType) {
    return { type: options.meetingType, source: 'stated', signals: [] };
  }

  const scores = new Map<MeetingType, number>();
  const signals: string[] = [];

  // Iterated over a typed key list rather than Object.entries, which widens the
  // key to string and would need an assertion to put back.
  for (const type of SCORED_TYPES) {
    let score = 0;
    for (const [pattern, weight] of MEETING_SIGNALS[type]) {
      const match = pattern.exec(transcript);
      if (match) {
        score += weight;
        // Only report the phrases that carried real weight, or the list turns
        // into every stopword in the transcript.
        if (weight >= 3) signals.push(match[0].toLowerCase());
      }
    }
    if (score > 0) scores.set(type, score);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [leader, runnerUp] = ranked;

  if (!leader) {
    return { type: 'ad-hoc', source: 'inferred', signals: [] };
  }

  // A tie on wording is what duration is for. It is never allowed to overrule
  // wording, because a long standup is still a standup.
  if (runnerUp && runnerUp[1] === leader[1] && options.durationMinutes !== undefined) {
    const byDuration = DURATION_HINTS.find(
      ([type, fits]) =>
        fits(options.durationMinutes ?? 0) && (type === leader[0] || type === runnerUp[0])
    );
    if (byDuration) {
      return {
        type: byDuration[0],
        source: 'inferred',
        signals: [...signals, `${options.durationMinutes} minutes`],
      };
    }
  }

  return { type: leader[0], source: 'inferred', signals: [...new Set(signals)] };
}

export function analyzeTranscript(
  transcript: string,
  options: TranscriptOptions = {}
): TranscriptAnalysis {
  const meeting = detectMeeting(transcript, options);

  if (!transcript || transcript.trim().length === 0) {
    return { meeting, actions: [] };
  }

  const candidates = [
    ...findCreateIssues(transcript, options),
    ...findAssignments(transcript, options),
    ...findTransitions(transcript, options),
    ...findBlockers(transcript, options),
    ...findWorkLogged(transcript, options),
    ...findSprintMoves(transcript, options),
    ...findEstimates(transcript, options),
  ].map((candidate) => weighForMeeting(candidate, meeting.type));

  return {
    meeting,
    actions: sortByConfidence(dedupe(candidates)).map(
      ({ span: _span, fit: _fit, ...action }) => action
    ),
  };
}

function findCreateIssues(transcript: string, options: TranscriptOptions): Candidate[] {
  // Every pattern skips the same filler between the noun and the summary, so
  // two patterns matching one sentence agree on what the summary is.
  const patterns = [
    /(?:create|add|open|file)\s+(?:a\s+)?(?:new\s+)?(issue|task|bug|story)(?:\s+(?:for|about|to))?[\s:]+([^.!?\n]+)/gi,
    /(?:we\s+need|should|must)\s+(?:to\s+)?(?:create|add|open|file)\s+(?:a\s+)?(issue|task|bug|story)(?:\s+(?:for|about|to))?[\s:]+([^.!?\n]+)/gi,
    /(?:create|add)\s+(?:a\s+)?jira\s+(issue|task|bug)\s+(?:for|titled|called)[\s:]+([^.!?\n]+)/gi,
  ];

  const actions: Candidate[] = [];

  for (const match of matchAll(transcript, patterns)) {
    const summary = (match[2] ?? '').trim();
    if (summary.length === 0) continue;

    const issueType = ISSUE_TYPES[(match[1] ?? '').toLowerCase()] ?? 'Task';
    const excerpt = excerptOf(match);

    actions.push({
      // The project is the one thing a transcript rarely states outright.
      confidence: options.projectKey ? 'high' : 'medium',
      tool: 'jira_create_issue',
      summary: options.projectKey
        ? `Create ${issueType} in ${options.projectKey}: "${truncate(summary, 80)}"`
        : `Create ${issueType} (project not named in transcript): "${truncate(summary, 80)}"`,
      arguments: {
        ...(options.projectKey ? { projectKey: options.projectKey } : {}),
        issueType,
        summary: truncate(summary, 255),
        description: `From meeting transcript:\n\n> ${excerpt}`,
      },
      excerpt,
      span: spanOf(match),
    });
  }

  return actions;
}

function findAssignments(transcript: string, options: TranscriptOptions): Candidate[] {
  // Each pattern names which group holds which value, rather than being
  // re-identified later by inspecting its own source text.
  const patterns: { regex: RegExp; user: number; target: number }[] = [
    {
      regex: new RegExp(`(?:assign|give|allocate)\\s+${TARGET}\\s+to\\s+([\\w.@-]+)`, 'gi'),
      target: 1,
      user: 2,
    },
    {
      regex: new RegExp(
        `([\\w.@-]+)\\s+(?:will|should|can|could|needs?\\s+to)\\s+(?:handle|take|own|work\\s+on|fix|implement)\\s+${TARGET}`,
        'gi'
      ),
      user: 1,
      target: 2,
    },
    {
      regex: new RegExp(
        `(?:assign|owner|responsible)\\s*:\\s*([\\w.@-]+)\\s+(?:for\\s+)?${TARGET}`,
        'gi'
      ),
      user: 1,
      target: 2,
    },
  ];

  const actions: Candidate[] = [];

  for (const { regex, user, target } of patterns) {
    for (const match of matchAll(transcript, [regex])) {
      const assignee = (match[user] ?? '').trim();
      const resolved = resolveTarget(match[target], options);
      if (assignee.length === 0) continue;

      actions.push({
        confidence: resolved.confidence,
        tool: 'jira_update_issue',
        summary: `Assign ${resolved.label} to ${assignee}`,
        arguments: {
          ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
          assignee,
        },
        excerpt: excerptOf(match),
        span: spanOf(match),
      });
    }
  }

  return actions;
}

function findTransitions(transcript: string, options: TranscriptOptions): Candidate[] {
  const patterns: { regex: RegExp; target: number; status?: number; fixed?: string }[] = [
    {
      regex: new RegExp(
        `(?:move|transition|mark|set)\\s+${TARGET}\\s+(?:to|as)\\s+([A-Za-z][A-Za-z -]*)`,
        'gi'
      ),
      target: 1,
      status: 2,
    },
    {
      regex: new RegExp(
        `(?:start|begin)\\s+(?:work\\s+on\\s+)?${TARGET}(?:\\s+(?:now|today|immediately))?`,
        'gi'
      ),
      target: 1,
      fixed: 'In Progress',
    },
    {
      regex: new RegExp(
        `(?:complete|completed|finish|finished|close|closed|done\\s+with)\\s+${TARGET}`,
        'gi'
      ),
      target: 1,
      fixed: 'Done',
    },
  ];

  const actions: Candidate[] = [];

  for (const { regex, target, status, fixed } of patterns) {
    for (const match of matchAll(transcript, [regex])) {
      const resolved = resolveTarget(match[target], options);
      const spoken = fixed ?? (status === undefined ? '' : (match[status] ?? '')).trim();
      if (spoken.length === 0) continue;

      const known = STATUS_NAMES[spoken.toLowerCase()];
      const transitionName = known ?? spoken;

      actions.push({
        // An unrecognised status name is a guess at what this project calls it.
        confidence: known ? resolved.confidence : 'low',
        tool: 'jira_transition_issue',
        summary: known
          ? `Transition ${resolved.label} to ${transitionName}`
          : `Transition ${resolved.label} to "${transitionName}" (name unverified — call jira_list_transitions)`,
        arguments: {
          ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
          // jira_transition_issue matches on name, not id: ids differ per project.
          transitionName,
        },
        excerpt: excerptOf(match),
        span: spanOf(match),
      });
    }
  }

  return actions;
}

/**
 * "CHG-20 is blocked on the vendor" -> a comment recording it.
 *
 * A blocker is the substance of a standup, and there is no blocked flag to set
 * here, so the durable form is a comment on the issue.
 */
function findBlockers(transcript: string, options: TranscriptOptions): Candidate[] {
  const patterns = [
    new RegExp(`${TARGET}\\s+is\\s+blocked\\s+(?:on|by)\\s+([^.!?\\n]+)`, 'gi'),
    new RegExp(
      `(?:I(?:'m| am)?\\s+)?blocked\\s+(?:on|by)\\s+([^.!?\\n]+?)\\s+(?:for|on)\\s+${TARGET}`,
      'gi'
    ),
  ];

  const actions: Candidate[] = [];

  // Group order differs between the two, so each is read on its own terms.
  const readings: { regex: RegExp; target: number; reason: number }[] = [
    { regex: patterns[0]!, target: 1, reason: 2 },
    { regex: patterns[1]!, target: 2, reason: 1 },
  ];

  for (const { regex, target, reason } of readings) {
    for (const match of matchAll(transcript, [regex])) {
      const resolved = resolveTarget(match[target], options);
      const cause = (match[reason] ?? '').trim();
      if (cause.length === 0) continue;

      actions.push({
        confidence: resolved.confidence,
        tool: 'jira_add_comment',
        summary: `Record on ${resolved.label} that it is blocked on ${truncate(cause, 60)}`,
        arguments: {
          ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
          comment: `Blocked on ${cause}\n\n_Noted from meeting transcript._`,
        },
        excerpt: excerptOf(match),
        span: spanOf(match),
      });
    }
  }

  return actions;
}

/** "I spent two hours on CHG-20" -> a worklog. */
function findWorkLogged(transcript: string, options: TranscriptOptions): Candidate[] {
  const patterns = [
    new RegExp(`(?:spent|logged|put)\\s+${DURATION}\\s+(?:in\\s+)?on\\s+${TARGET}`, 'gi'),
    new RegExp(`${TARGET}\\s+took\\s+(?:me\\s+)?${DURATION}`, 'gi'),
  ];

  const readings: { regex: RegExp; target: number; duration: number }[] = [
    { regex: patterns[0]!, duration: 1, target: 2 },
    { regex: patterns[1]!, target: 1, duration: 2 },
  ];

  const actions: Candidate[] = [];

  for (const { regex, target, duration } of readings) {
    for (const match of matchAll(transcript, [regex])) {
      const resolved = resolveTarget(match[target], options);
      const spent = normaliseDuration(match[duration] ?? '');
      if (!spent) continue;

      actions.push({
        confidence: resolved.confidence,
        tool: 'jira_log_work',
        summary: `Log ${spent} against ${resolved.label}`,
        arguments: {
          ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
          timeSpent: spent,
        },
        excerpt: excerptOf(match),
        span: spanOf(match),
      });
    }
  }

  return actions;
}

/** "pull CHG-20 into the sprint" / "drop it from the sprint". */
function findSprintMoves(transcript: string, options: TranscriptOptions): Candidate[] {
  const intoSprint = new RegExp(
    `(?:pull|bring|move|add|commit)\\s+${TARGET}\\s+(?:in|into|to|onto)\\s+(?:the\\s+)?(?:current\\s+|next\\s+)?sprint`,
    'gi'
  );
  const outOfSprint = new RegExp(
    `(?:pull|drop|remove|take)\\s+${TARGET}\\s+(?:out\\s+of|off|from)\\s+(?:the\\s+)?sprint`,
    'gi'
  );

  const actions: Candidate[] = [];

  for (const match of matchAll(transcript, [intoSprint])) {
    const resolved = resolveTarget(match[1], options);
    actions.push({
      // jira_move_issue_to_sprint needs a sprint id, which a transcript never says.
      // Without one from the caller this is a real observation with an
      // incomplete call, so it is reported as the weaker reading it is.
      confidence: options.sprintId ? resolved.confidence : 'low',
      tool: 'jira_move_issue_to_sprint',
      summary: options.sprintId
        ? `Move ${resolved.label} into sprint ${options.sprintId}`
        : `Move ${resolved.label} into the sprint (sprint id unknown — call jira_list_sprints)`,
      arguments: {
        ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
        ...(options.sprintId ? { sprintId: options.sprintId } : {}),
      },
      excerpt: excerptOf(match),
      span: spanOf(match),
    });
  }

  for (const match of matchAll(transcript, [outOfSprint])) {
    const resolved = resolveTarget(match[1], options);
    actions.push({
      confidence: resolved.confidence,
      tool: 'jira_remove_issue_from_sprint',
      summary: `Remove ${resolved.label} from the sprint`,
      arguments: { ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}) },
      excerpt: excerptOf(match),
      span: spanOf(match),
    });
  }

  return actions;
}

/**
 * Estimation, which is most of what planning does.
 *
 * Story points and the original estimate are both settable through jira_update_issue
 * now, which resolves the per-instance field by name, so these are ordinary
 * recommendations rather than something to report as impossible. The field id
 * deliberately does not appear here: this function has no API access, and
 * guessing one is how you write to the wrong field.
 */
function findEstimates(transcript: string, options: TranscriptOptions): Candidate[] {
  const POINTS = '(\\d+(?:\\.\\d+)?)';
  const readings: {
    regex: RegExp;
    target: number;
    value: number;
    build: (value: string) => { args: Record<string, unknown>; summary: string };
  }[] = [
    {
      regex: new RegExp(`${TARGET}\\s+(?:is|at|=)\\s*${POINTS}\\s*(?:story\\s+)?points?`, 'gi'),
      target: 1,
      value: 2,
      build: (value) => ({
        args: { storyPoints: Number(value) },
        summary: `${value} story points`,
      }),
    },
    {
      regex: new RegExp(`${POINTS}\\s*(?:story\\s+)?points?\\s+(?:for|on)\\s+${TARGET}`, 'gi'),
      target: 2,
      value: 1,
      build: (value) => ({
        args: { storyPoints: Number(value) },
        summary: `${value} story points`,
      }),
    },
    {
      regex: new RegExp(
        `(?:estimate|estimating)\\s+(?:for\\s+)?${TARGET}\\s+(?:is|at)\\s*${DURATION}`,
        'gi'
      ),
      target: 1,
      value: 2,
      build: (value) => {
        const spent = normaliseDuration(value) ?? value.trim();
        return { args: { originalEstimate: spent }, summary: `an original estimate of ${spent}` };
      },
    },
    {
      regex: new RegExp(`${TARGET}\\s+(?:will|should)\\s+take\\s+${DURATION}`, 'gi'),
      target: 1,
      value: 2,
      build: (value) => {
        const spent = normaliseDuration(value) ?? value.trim();
        return { args: { originalEstimate: spent }, summary: `an original estimate of ${spent}` };
      },
    },
  ];

  const actions: Candidate[] = [];

  for (const { regex, target, value, build } of readings) {
    for (const match of matchAll(transcript, [regex])) {
      const resolved = resolveTarget(match[target], options);
      const raw = match[value] ?? '';
      if (raw.trim().length === 0) continue;

      const { args, summary } = build(raw);

      actions.push({
        confidence: resolved.confidence,
        tool: 'jira_update_issue',
        summary: `Set ${summary} on ${resolved.label}`,
        arguments: {
          ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
          ...args,
        },
        excerpt: excerptOf(match),
        span: spanOf(match),
        // Estimation happens in planning. Heard in a standup it is more likely a
        // recollection than an instruction.
        fit: ['sprint-planning', 'ad-hoc'],
      });
    }
  }

  return actions;
}

/** Jira accepts "2h" and "30m"; spoken forms need the unit shortened. */
function normaliseDuration(spoken: string): string | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(spoken.trim());
  if (!match) return null;

  const unit = (match[2] ?? '').toLowerCase();
  const suffix = unit.startsWith('w')
    ? 'w'
    : unit.startsWith('d')
      ? 'd'
      : unit.startsWith('h')
        ? 'h'
        : unit.startsWith('m')
          ? 'm'
          : null;

  return suffix ? `${match[1]}${suffix}` : null;
}

/**
 * Shift confidence by how well the reading fits the meeting.
 *
 * Only ever downward, and only one step. A standup that really did agree to
 * file a bug still surfaces it; it just says "medium" rather than "high", which
 * is the honest reading of a sentence heard in the wrong room.
 */
const EXPECTED_IN: Record<string, MeetingType[]> = {
  jira_create_issue: ['sprint-planning', 'retro', 'ad-hoc'],
  jira_move_issue_to_sprint: ['sprint-planning'],
  jira_remove_issue_from_sprint: ['sprint-planning'],
  jira_log_work: ['standup', 'ad-hoc'],
  jira_add_comment: ['standup', 'retro', 'ad-hoc'],
};

function weighForMeeting(candidate: Candidate, type: MeetingType): Candidate {
  const expected = candidate.fit ?? EXPECTED_IN[candidate.tool];
  if (!expected || expected.includes(type)) return candidate;

  const weakened: RecommendedAction['confidence'] =
    candidate.confidence === 'high' ? 'medium' : 'low';
  return { ...candidate, confidence: weakened };
}

/**
 * Resolve the issue a sentence refers to.
 *
 * A pronoun only resolves if the caller said which issue is under discussion.
 * Otherwise the action is kept without an `issueKey` — the observation is still
 * worth reporting — and says so, rather than inventing a placeholder key that
 * looks callable.
 */
function resolveTarget(
  raw: string | undefined,
  options: TranscriptOptions
): { issueKey: string | null; label: string; confidence: 'high' | 'medium' | 'low' } {
  const spoken = (raw ?? '').trim();

  if (spoken.length > 0 && !PRONOUNS.has(spoken.toLowerCase())) {
    return { issueKey: spoken, label: spoken, confidence: 'high' };
  }

  if (options.issueKey) {
    return {
      issueKey: options.issueKey,
      label: `${options.issueKey} (referred to as "${spoken}")`,
      confidence: 'medium',
    };
  }

  return {
    issueKey: null,
    label: `the issue referred to as "${spoken || 'unnamed'}"`,
    confidence: 'low',
  };
}

/**
 * Run every pattern over the transcript.
 *
 * The regexes are global and carry `lastIndex` between calls, so each is reset
 * before use — a pattern reused across two transcripts would otherwise resume
 * mid-string and silently miss the opening matches.
 */
function matchAll(transcript: string, patterns: readonly RegExp[]): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(transcript)) !== null) {
      matches.push(match);
      // A zero-length match would loop forever.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }

  return matches;
}

function spanOf(match: RegExpExecArray): readonly [number, number] {
  return [match.index, match.index + match[0].length];
}

function excerptOf(match: RegExpExecArray): string {
  return truncate(match[0].replace(/\s+/g, ' ').trim(), EXCERPT_LENGTH);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Reduce overlapping readings of the same sentence to one.
 *
 * Two passes, because they catch different things: identical arguments from
 * different sentences ("assign CHG-20 to dana" said twice) collapse on the key,
 * while two patterns reading one sentence differently collapse on the span.
 * The stronger reading wins; ties keep the first, and the patterns are ordered
 * most specific first.
 */
function dedupe(candidates: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const key = `${candidate.tool}:${JSON.stringify(candidate.arguments)}`;
    const existing = byKey.get(key);
    if (!existing || rank(candidate) < rank(existing)) {
      byKey.set(key, candidate);
    }
  }

  const kept: Candidate[] = [];
  for (const candidate of byKey.values()) {
    const clash = kept.findIndex(
      (other) => other.tool === candidate.tool && overlaps(other.span, candidate.span)
    );
    if (clash === -1) {
      kept.push(candidate);
    } else if (rank(candidate) < rank(kept[clash]!)) {
      kept[clash] = candidate;
    }
  }

  return kept;
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]): boolean =>
  a[0] < b[1] && b[0] < a[1];

const rank = (action: RecommendedAction): number =>
  ({ high: 0, medium: 1, low: 2 })[action.confidence];

function sortByConfidence(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

/** Format the analysis as markdown for human review. */
export function formatActionsAsMarkdown(analysis: TranscriptAnalysis): string {
  const { meeting, actions } = analysis;

  const lines = [`# Transcript analysis`, ''];

  const described =
    meeting.source === 'stated'
      ? `Meeting type: **${MEETING_LABELS[meeting.type]}** (as given).`
      : meeting.signals.length > 0
        ? `Meeting type: **${MEETING_LABELS[meeting.type]}** — inferred from ${meeting.signals
            .map((signal) => `"${signal}"`)
            .join(', ')}.`
        : `Meeting type: **${MEETING_LABELS[meeting.type]}** — nothing in the transcript identified it.`;

  lines.push(described, '');

  if (meeting.source === 'inferred') {
    // The type shifts confidence, so a wrong guess should be correctable
    // rather than something the reader has to work out from odd scoring.
    lines.push(
      `_If that is wrong, pass \`meetingType\` and the confidences below change accordingly._`,
      ''
    );
  }

  if (actions.length === 0) {
    lines.push(
      'No actionable items detected. This looks for phrasings like "create a task for…",',
      '"assign PROJ-12 to dana", "move PROJ-12 to done", "blocked on…", "spent 2h on PROJ-12",',
      '"PROJ-12 is 5 points" and "pull PROJ-12 into the sprint".'
    );
  } else {
    lines.push(`Found ${actions.length} suggested action${actions.length === 1 ? '' : 's'}:`, '');

    actions.forEach((action, index) => {
      lines.push(
        `## ${index + 1}. ${action.summary}`,
        `- **Tool:** \`${action.tool}\``,
        `- **Confidence:** ${action.confidence}`,
        '- **Arguments:**',
        '```json',
        JSON.stringify(action.arguments, null, 2),
        '```',
        `- **Heard as:** "${action.excerpt}"`,
        ''
      );
    });
  }

  if (actions.length > 0) {
    lines.push(
      '**Nothing above has been executed.** Review each one and call the tool yourself.',
      'Arguments shown without an `issueKey` need one supplied before they can run.'
    );
  }

  return lines.join('\n');
}

const MEETING_LABELS: Record<MeetingType, string> = {
  standup: 'standup',
  'sprint-planning': 'sprint planning',
  retro: 'retrospective',
  'ad-hoc': 'ad-hoc meeting',
};
