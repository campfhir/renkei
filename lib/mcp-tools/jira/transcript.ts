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
}

export interface TranscriptOptions {
  /** Default project for created issues. */
  projectKey?: string | undefined;
  /** The issue under discussion, used to resolve "this", "it" and "that". */
  issueKey?: string | undefined;
}

/** Jira issue keys: uppercase project key, dash, number. */
const ISSUE_KEY = '[A-Z][A-Z0-9_]*-\\d+';
/** An issue named outright, or referred to by pronoun. */
const TARGET = `(${ISSUE_KEY}|this|it|that)`;

const PRONOUNS = new Set(['this', 'it', 'that']);

const EXCERPT_LENGTH = 120;

/**
 * Statuses worth normalising. Anything else is passed through as written and
 * marked low confidence — `transition_issue` matches on name and reports the
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

export function analyzeTranscript(
  transcript: string,
  options: TranscriptOptions = {}
): RecommendedAction[] {
  if (!transcript || transcript.trim().length === 0) {
    return [];
  }

  const candidates = [
    ...findCreateIssues(transcript, options),
    ...findAssignments(transcript, options),
    ...findTransitions(transcript, options),
  ];

  return sortByConfidence(dedupe(candidates)).map(({ span: _span, ...action }) => action);
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
      tool: 'create_issue',
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
        tool: 'update_issue',
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
        tool: 'transition_issue',
        summary: known
          ? `Transition ${resolved.label} to ${transitionName}`
          : `Transition ${resolved.label} to "${transitionName}" (name unverified — call list_transitions)`,
        arguments: {
          ...(resolved.issueKey ? { issueKey: resolved.issueKey } : {}),
          // transition_issue matches on name, not id: ids differ per project.
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

/** Format actions as markdown for human review. */
export function formatActionsAsMarkdown(actions: readonly RecommendedAction[]): string {
  if (actions.length === 0) {
    return [
      '# Transcript analysis',
      '',
      'No actionable items detected. This looks for phrasings like "create a task for…",',
      '"assign PROJ-12 to dana", and "move PROJ-12 to done".',
    ].join('\n');
  }

  const lines = [
    '# Transcript analysis',
    '',
    `Found ${actions.length} suggested action${actions.length === 1 ? '' : 's'}:`,
    '',
  ];

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

  lines.push(
    '**Nothing above has been executed.** Review each one and call the tool yourself.',
    'Arguments shown without an `issueKey` need one supplied before they can run.'
  );

  return lines.join('\n');
}
