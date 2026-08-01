/**
 * Example Scrum playbooks, written into a tenant's `tenant_playbooks` the
 * moment it is created — a starting point, not a default a tenant is bound
 * to. Each names real tool identifiers so an author editing them later has a
 * working example to imitate. No "restore defaults" feature exists: once
 * seeded, these are ordinary rows a tenant can edit or delete freely.
 *
 * Seeded from two places, so a tenant ends up in the same state whichever way
 * it was created: the self-service wizard's commit step, and
 * `pnpm tenant create`.
 */

export interface PlaybookSeed {
  slug: string;
  title: string;
  bodyMarkdown: string;
}

export const PLAYBOOK_SEEDS: readonly PlaybookSeed[] = [
  {
    slug: 'sprint-planning',
    title: 'Sprint Planning',
    bodyMarkdown: [
      "Before the meeting, call `list_boards` to find the team's board, then `list_sprints` to",
      'see what sprint is already open or about to start.',
      '',
      'Pull candidate work with `search_issues`, e.g. a JQL like',
      '`project = SCRUM AND status = Backlog ORDER BY priority DESC` — read the top few with',
      '`get_issue` if the team needs the full description to size something.',
      '',
      'If there is no sprint yet, create one with `create_sprint`. As the team commits to items,',
      'use `move_issue_to_sprint` to move each one in.',
    ].join('\n'),
  },
  {
    slug: 'standup',
    title: 'Daily Standup',
    bodyMarkdown: [
      "Call `list_sprints` on the team's board to find the active sprint, then `search_issues`",
      'with a JQL like `sprint = <id> ORDER BY status` to see what is in progress, done, and',
      'blocked.',
      '',
      'For anything reported as blocked, `get_issue` reads the full description and recent',
      'comments so the blocker can be summarized without asking the reporter to repeat it.',
      '',
      'This playbook does not update anything — standup is a status read, not a planning step.',
    ].join('\n'),
  },
  {
    slug: 'retro',
    title: 'Sprint Retrospective',
    bodyMarkdown: [
      'Call `list_sprints` and find the sprint that just closed (or `complete_sprint` it first',
      'if it is still open), then `search_issues` scoped to that sprint to see what actually',
      'shipped versus what carried over.',
      '',
      'Issues that carried over are worth a `get_issue` to see whether a comment already explains',
      'why — `add_comment` is the right tool to capture a retro action item directly on the',
      'issue it concerns, rather than only in a separate notes document.',
      '',
      'Format: what went well, what did not, one or two concrete changes for next sprint.',
    ].join('\n'),
  },
];
