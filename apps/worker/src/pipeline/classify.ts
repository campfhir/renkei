/**
 * Classification v1: does a chat message look like an issue report, and if
 * so, what Jira issue should it become?
 *
 * Deliberately a heuristic, not a model call — the pipeline's classify stage
 * is pluggable, and RENKEI.md's LLM strategy (cheap classification on every
 * event, heavier reasoning only for survivors) starts honestly with the
 * cheapest possible tier: patterns. The contract that matters is the output
 * shape — a title, a summary, and one suggested action in tool-call form
 * with arguments the action executor accepts verbatim — because a suggestion
 * that cannot be executed as-is is worse than none.
 */

export interface SuggestedAction {
  tool: 'jira_create_issue';
  args: {
    summary: string;
    description: string;
    issueType: string;
  };
}

export interface MessageClassification {
  title: string;
  summary: string;
  suggestedAction: SuggestedAction;
}

/**
 * Phrases that make a message read as something going wrong. Word-boundaried
 * so "issue" matches but "tissue" does not.
 */
const ISSUE_SIGNALS = new RegExp(
  '\\b(' +
    [
      'error',
      'errors',
      'broken',
      'breaks',
      'down',
      'outage',
      'failing',
      'failed',
      'fails',
      'failure',
      'bug',
      'crash',
      'crashes',
      'crashed',
      'timeout',
      'timeouts',
      'timed out',
      'stuck',
      'unable to',
      'cannot', // "can't" is normalized to "cannot" before matching
      'not working',
      "doesn't work",
      'does not work',
      'issue',
      'incident',
    ].join('|') +
    ')\\b',
  'i'
);

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function classifyMessage(text: string): MessageClassification | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/can['’]t/gi, 'cannot').replace(/won['’]t/gi, 'will not');
  if (!ISSUE_SIGNALS.test(normalized)) return null;

  const headline = clip(firstLine(trimmed), 80);

  return {
    title: `Possible issue report: ${headline}`,
    summary: clip(trimmed, 280),
    suggestedAction: {
      tool: 'jira_create_issue',
      args: {
        summary: headline,
        description: `Reported in WebEx:\n\n> ${trimmed.split('\n').join('\n> ')}`,
        issueType: 'Task',
      },
    },
  };
}
