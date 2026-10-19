import { parseDraftReply } from './draft-from-prose';

const context = {
  validTools: new Set(['jira_add_comment', 'jira_search_issues']),
  triggerOffer: null,
  offerGuardrails: false,
};

const instructions = (extra: string) =>
  [
    '## Goal',
    `Keep it current. ${extra}`,
    '## Context',
    'x',
    '## Approach',
    'x',
    '## Tools',
    'x',
    '## Actions',
    'x',
    '## Done when',
    'x',
    '## Rules',
    'x',
  ].join('\n');

function parse(reply: Record<string, unknown>) {
  const parsed = parseDraftReply(JSON.stringify(reply), context);
  if (!('draft' in parsed)) throw new Error(parsed.problems.join('; '));
  return parsed;
}

describe('parseDraftReply tool and question checks', () => {
  it('flags a tool the instructions name but the tool list omits', () => {
    const parsed = parse({
      instructions: instructions('Use jira_search_issues to look.'),
      tools: ['jira_add_comment'],
    });
    expect(parsed.softProblems).toEqual([expect.stringContaining('jira_search_issues')]);
  });

  it('is clean when every named tool is listed', () => {
    const parsed = parse({
      instructions: instructions('Use jira_search_issues to look.'),
      tools: ['jira_search_issues'],
    });
    expect(parsed.softProblems).toEqual([]);
  });

  it('carries canAskQuestions, and flags ask_person without it', () => {
    expect(
      parse({ instructions: instructions('Ask with ask_person.'), tools: [], canAskQuestions: true })
        .draft.canAskQuestions
    ).toBe(true);
    const parsed = parse({ instructions: instructions('Ask with ask_person.'), tools: [] });
    expect(parsed.draft.canAskQuestions).toBeUndefined();
    expect(parsed.softProblems).toEqual([expect.stringContaining('canAskQuestions')]);
  });
});
