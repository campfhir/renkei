/**
 * Flattening a Jira issue.
 *
 * The regression that matters most is the first one: descriptions arrive as
 * ADF node trees, and a string coercion over an object silently yields
 * nothing. That is how every indexed issue came to contain its own title
 * twice and no content at all.
 */

import { jiraDocument } from './jira-document';

const adf = (...paragraphs: string[]) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  })),
});

const issue = (fields: Record<string, unknown>, key = 'SUP-4821') => ({ key, fields });

describe('jiraDocument', () => {
  it('includes the description, which used to be dropped entirely', () => {
    const document = jiraDocument(
      issue({
        summary: 'Login fails after SSO migration',
        description: adf('Customer cannot log in since the tenant moved to SSO.'),
      })
    );
    expect(document).toContain('## Description');
    expect(document).toContain('Customer cannot log in since the tenant moved to SSO.');
  });

  it('leads with the summary rather than repeating the key', () => {
    const document = jiraDocument(issue({ summary: 'Login fails after SSO migration' }));
    expect(document.startsWith('# Login fails after SSO migration')).toBe(true);
  });

  it('names people, not account ids', () => {
    const document = jiraDocument(
      issue({
        summary: 'S',
        reporter: { displayName: 'Priya Raman', accountId: '5f3a' },
        assignee: { displayName: 'Dana Whitfield', accountId: '61bc' },
      }),
      { reporter: 'Reporter', assignee: 'Assignee' }
    );
    expect(document).toContain('Reporter: Priya Raman');
    expect(document).toContain('Assignee: Dana Whitfield');
    expect(document).not.toContain('5f3a');
  });

  it('uses Jira’s own display names for custom fields', () => {
    // The reason `expand: names` is requested: this id differs per site, so
    // no hardcoded list could find request participants.
    const document = jiraDocument(
      issue({
        summary: 'S',
        customfield_10101: [{ displayName: 'Sam Okafor' }, { displayName: 'Lee Chen' }],
      }),
      { customfield_10101: 'Request participants' }
    );
    expect(document).toContain('Request participants: Sam Okafor, Lee Chen');
    expect(document).not.toContain('customfield_10101');
  });

  it('joins multi-valued fields on one line', () => {
    const document = jiraDocument(issue({ summary: 'S', labels: ['billing', 'sso', 'urgent'] }), {
      labels: 'Labels',
    });
    expect(document).toContain('Labels: billing, sso, urgent');
  });

  it('unwraps the shapes Jira uses for a single value', () => {
    const document = jiraDocument(
      issue({
        summary: 'S',
        status: { name: 'In Progress' },
        priority: { name: 'High' },
        customfield_1: { value: 'Tier 2' },
      }),
      { status: 'Status', priority: 'Priority', customfield_1: 'Support tier' }
    );
    expect(document).toContain('Status: In Progress');
    expect(document).toContain('Priority: High');
    expect(document).toContain('Support tier: Tier 2');
  });

  it('gives a rich-text field its own heading instead of one long line', () => {
    // A `Label: value` line cannot hold prose without destroying both the
    // value and the list around it.
    const document = jiraDocument(
      issue({
        summary: 'S',
        customfield_20: adf('Given a migrated tenant', 'When they sign in'),
      }),
      { customfield_20: 'Acceptance criteria' }
    );
    expect(document).toContain('### Acceptance criteria');
    expect(document).toContain('Given a migrated tenant');
    expect(document).not.toContain('Acceptance criteria: Given');
  });

  it('includes comments with who said them and when', () => {
    const document = jiraDocument(
      issue({
        summary: 'S',
        comment: {
          comments: [
            {
              author: { displayName: 'Priya Raman' },
              created: '2026-08-12T09:00:00.000+0000',
              body: adf('Reproduced on staging.'),
            },
            {
              author: { displayName: 'Dana Whitfield' },
              created: '2026-08-13T11:30:00.000+0000',
              body: adf('Fix is in review.'),
            },
          ],
        },
      })
    );
    expect(document).toContain('## Comments');
    expect(document).toContain('### Priya Raman — 2026-08-12');
    expect(document).toContain('Reproduced on staging.');
    expect(document).toContain('### Dana Whitfield — 2026-08-13');
    expect(document).toContain('Fix is in review.');
  });

  it('keeps the newest comments and says how many it dropped', () => {
    const comments = Array.from({ length: 25 }, (_, i) => ({
      author: { displayName: `Person ${i}` },
      created: '2026-08-13T11:30:00.000+0000',
      body: adf(`Comment number ${i}`),
    }));
    const document = jiraDocument(issue({ summary: 'S', comment: { comments } }));
    expect(document).toContain('5 earlier comments not included');
    expect(document).toContain('Comment number 24');
    expect(document).not.toContain('Comment number 4\n');
  });

  it('omits sections that have nothing in them', () => {
    const document = jiraDocument(issue({ summary: 'Just a title' }));
    expect(document).not.toContain('## Description');
    expect(document).not.toContain('## Comments');
    // Key alone is still worth a Fields section.
    expect(document).toContain('Key: SUP-4821');
  });

  it('is stable across syncs for the same issue', () => {
    // A reordered document is a needless re-embed, and object key order is
    // not a promise.
    const fields = { summary: 'S', status: { name: 'Open' }, labels: ['b', 'a'] };
    expect(jiraDocument(issue(fields))).toBe(jiraDocument(issue({ ...fields })));
  });

  it('falls back to a readable label when Jira sends no name', () => {
    const document = jiraDocument(issue({ summary: 'S', fixVersions: [{ name: '2026.8' }] }));
    expect(document).toContain('Fix versions: 2026.8');
  });

  it('drops noise nobody would search for', () => {
    const document = jiraDocument(
      issue({ summary: 'S', workratio: -1, votes: { votes: 0 }, thumbnail: 'https://x/y.png' })
    );
    expect(document).not.toContain('workratio');
    expect(document).not.toContain('thumbnail');
  });
});

describe('dates', () => {
  it('renders a timestamp as the day', () => {
    const document = jiraDocument(
      { key: 'S-1', fields: { summary: 'S', created: '2026-08-11T08:00:00.000+0000' } },
      { created: 'Created' }
    );
    expect(document).toContain('Created: 2026-08-11');
    expect(document).not.toContain('08:00:00');
  });
});

describe('an author’s own headings', () => {
  const heading = (level: number, text: string) => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }],
  });
  const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

  it('nests description headings below the Description section', () => {
    const document = jiraDocument(
      issue({ summary: 'S', description: doc(heading(1, 'Overview'), heading(2, 'Impact')) })
    );
    expect(document).toContain('## Description');
    // Level 1 and 2 in the source land at 3 and 4 — under their section, and
    // still distinguishable from each other.
    expect(document).toContain('### Overview');
    expect(document).toContain('#### Impact');
    expect(document).not.toMatch(/^# Overview$/m);
  });

  it('stops a comment heading impersonating a document section', () => {
    // The dangerous one: "## Fields" in a comment would otherwise read as the
    // issue's real field list.
    const document = jiraDocument(
      issue({
        summary: 'S',
        comment: {
          comments: [
            {
              author: { displayName: 'Priya Raman' },
              created: '2026-08-12T09:00:00.000+0000',
              body: doc(heading(2, 'Fields'), {
                type: 'paragraph',
                content: [{ type: 'text', text: 'nope' }],
              }),
            },
          ],
        },
      })
    );
    // Exactly one line is the real Fields section.
    expect(document.split('\n').filter((line) => line === '## Fields')).toHaveLength(1);
    expect(document).toContain('##### Fields');
  });

  it('nests headings inside a rich-text field below its own heading', () => {
    const document = jiraDocument(
      issue({ summary: 'S', customfield_20: doc(heading(1, 'Given')) }),
      { customfield_20: 'Acceptance criteria' }
    );
    expect(document).toContain('### Acceptance criteria');
    expect(document).toContain('#### Given');
  });

  it('leaves the document’s own headings at their levels', () => {
    const document = jiraDocument(
      issue({ summary: 'Login fails', description: doc(heading(1, 'Overview')) })
    );
    expect(document.startsWith('# Login fails')).toBe(true);
    expect(document).toContain('## Description');
  });
});
