/**
 * The issue cards beside the project screen's active chat
 * (issue-cards.tsx): what the …/chats/[chatId]/issues answer becomes on
 * screen. A Jira issue and a GitHub issue, Jira first, each a link with
 * its key or number, title and status; nothing at all when neither
 * resolves — no token, an API failure (the read failing), or no
 * reference found are the same "say nothing" case, never an error to
 * show. Tested in issue-cards.model.test.ts.
 */

import { isRecord, isString } from '@renkei/guards';

export interface IssueCard {
  /** `PROJ-9`, or `#41` for a GitHub issue. */
  label: string;
  title: string;
  /** Its status or state, as the tracker words it; empty for none. */
  sub: string;
  url: string;
}

/** The cards an answer shows, Jira's first; none for a failed read or an answer that names nothing. */
export function issueCardsOf(answer: unknown): IssueCard[] {
  if (!isRecord(answer)) return [];
  const cards: IssueCard[] = [];
  const { jira, github } = answer;
  if (isRecord(jira) && isString(jira.key) && jira.key && isString(jira.url)) {
    cards.push({
      label: jira.key,
      title: isString(jira.title) ? jira.title : '',
      sub: isString(jira.status) ? jira.status : '',
      url: jira.url,
    });
  }
  if (isRecord(github) && typeof github.number === 'number' && isString(github.url)) {
    cards.push({
      label: `#${github.number}`,
      title: isString(github.title) ? github.title : '',
      sub: isString(github.state) ? github.state : '',
      url: github.url,
    });
  }
  return cards;
}

/** A card's line: its key and, when there is one, its title. */
export function cardLine(card: IssueCard): string {
  return `${card.label} ${card.title ? `· ${card.title}` : ''}`;
}
