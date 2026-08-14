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

describe('shapes a real instance actually returns', () => {
  it('takes a description that arrives as a plain string', () => {
    // v3 returns ADF; v2 — and some Cloud responses — return a string.
    // Running the ADF converter over a string yields nothing, which is the
    // same silent drop that hid descriptions before, by a different route.
    const document = jiraDocument(issue({ summary: 'S', description: 'Review' }));
    expect(document).toContain('## Description');
    expect(document).toContain('Review');
  });

  it('takes a comment body that arrives as a plain string', () => {
    const document = jiraDocument(
      issue({
        summary: 'S',
        comment: {
          comments: [
            {
              author: { displayName: 'Alex Mercer' },
              created: '2026-06-02T09:00:00.000-0700',
              body: 'Looks done to me.',
            },
          ],
        },
      })
    );
    expect(document).toContain('Looks done to me.');
  });

  it('drops machine plumbing that wears a perfectly good field name', () => {
    // All three came off one real issue, under ordinary display names.
    const document = jiraDocument(
      issue({
        summary: 'S',
        customfield_10019: '1|i1dxy7:',
        customfield_10020: '1|i1g0gc:zr',
        customfield_10025: '10010_*:*_1_*:*_0_*|*_10126_*:*_1_*:*_21949782',
        customfield_10000: '{}',
      }),
      {
        customfield_10019: 'Rank',
        customfield_10025: 'Workflow property',
        customfield_10000: 'Config',
      }
    );
    expect(document).not.toContain('Rank:');
    expect(document).not.toContain('Workflow property:');
    expect(document).not.toContain('Config:');
  });

  it('drops the status category, which only repeats the status', () => {
    const document = jiraDocument(
      issue({ summary: 'S', status: { name: 'Done' }, statusCategory: { name: 'Done' } }),
      { status: 'Status', statusCategory: 'Status Category' }
    );
    expect(document).toContain('Status: Done');
    expect(document).not.toContain('Status Category');
  });

  it('drops raw second counts, keeping the readable time tracking out of it', () => {
    const document = jiraDocument(
      issue({ summary: 'S', timespent: 900, aggregatetimespent: 900, timeestimate: 0 })
    );
    expect(document).not.toContain('900');
  });

  it('keeps the parent issue, which is real context', () => {
    const document = jiraDocument(
      issue({
        summary: 'S',
        parent: { key: 'OPS-1040', fields: { summary: 'Quarterly rollout' } },
      }),
      { parent: 'Parent' }
    );
    expect(document).toContain('Parent: OPS-1040');
  });
});

describe('wiki markup and mentions', () => {
  it('keeps a numbered plan numbered instead of turning it into headings', () => {
    // `#` starts an ordered item in wiki markup and a heading in markdown.
    // Untranslated, a real backout plan became four headings with no order.
    const document = jiraDocument(
      issue({ summary: 'S', customfield_1: '# Redeploy the image\n# Restart the service' }),
      { customfield_1: 'Backout Plan' }
    );
    expect(document).toContain('1. Redeploy the image');
    expect(document).not.toContain('# Redeploy the image');
  });

  it('converts wiki headings, which are hN. and not hashes', () => {
    const document = jiraDocument(
      issue({ summary: 'S', description: 'h3. Change reason\n\nPrepare the server.' })
    );
    // Demoted to sit under `## Description`.
    expect(document).toContain('##### Change reason');
  });

  it('resolves a mention to the person’s name using the issue’s own data', () => {
    // `[~accountid:…]` embeds an opaque id where a name belongs: unsearchable
    // and pure token cost. The same person appears elsewhere in the payload.
    const document = jiraDocument(
      issue({
        summary: 'S',
        assignee: { accountId: 'abc123', displayName: 'Jordan Ellis' },
        comment: {
          comments: [
            {
              author: { accountId: 'xyz789', displayName: 'Robin Vale' },
              created: '2026-08-05T22:00:00.000-0700',
              body: '[~accountid:abc123] — completeness pass applied.',
            },
          ],
        },
      })
    );
    expect(document).toContain('@Jordan Ellis');
    expect(document).not.toContain('abc123');
  });

  it('does not leave an unresolvable id in the text', () => {
    const document = jiraDocument(
      issue({
        summary: 'S',
        comment: {
          comments: [
            {
              author: { displayName: 'Someone' },
              created: '2026-08-05T22:00:00.000-0700',
              body: '[~accountid:never-seen-before] please review',
            },
          ],
        },
      })
    );
    expect(document).not.toContain('never-seen-before');
    expect(document).toContain('@someone');
  });
});

describe('field labels', () => {
  it('drops a value that only restates its own label', () => {
    // SLA fields render as their own name; the useful part is a cycle object
    // this does not read, so the line carries nothing.
    const document = jiraDocument(
      issue({ summary: 'S', customfield_1: { name: 'Issue Resolution' } }),
      { customfield_1: 'Issue Resolution' }
    );
    expect(document).not.toContain('Issue Resolution: Issue Resolution');
  });

  it('strips Jira’s bracketed administrative marker from a label', () => {
    const document = jiraDocument(issue({ summary: 'S', customfield_2: '2026-07-15' }), {
      customfield_2: '[CHART] Date of First Response',
    });
    expect(document).toContain('Date of First Response: 2026-07-15');
    expect(document).not.toContain('[CHART]');
  });
});

describe('fields that belong on the issue', () => {
  const screen = new Set(['customfield_10029']);

  it('drops a custom field the project no longer shows', () => {
    // A reconfigured project leaves values behind on fields that are off the
    // screen. Indexing them puts words in the issue's mouth — an issue whose
    // form has no "Type of Engagement" was being indexed as having one.
    const document = jiraDocument(
      issue({ summary: 'S', customfield_10744: { value: 'Broadcast/Notification' } }),
      { customfield_10744: 'Type of Engagement' },
      screen
    );
    expect(document).not.toContain('Type of Engagement');
  });

  it('keeps a custom field that is on the screen', () => {
    const document = jiraDocument(
      issue({ summary: 'S', customfield_10029: [{ displayName: 'Alex Mercer' }] }),
      { customfield_10029: 'Request participants' },
      screen
    );
    expect(document).toContain('Request participants: Alex Mercer');
  });

  it('never filters system fields against the edit screen', () => {
    // Edit metadata describes what can be EDITED, so it has no status,
    // resolution or dates. Filtering system fields against it would delete
    // the spine of the document.
    const document = jiraDocument(
      issue({
        summary: 'S',
        status: { name: 'Done' },
        resolution: { name: 'Fixed' },
        created: '2026-08-11T08:00:00.000+0000',
        components: [{ name: 'Pharmacy' }],
      }),
      { status: 'Status', resolution: 'Resolution', created: 'Created', components: 'Components' },
      screen
    );
    expect(document).toContain('Status: Done');
    expect(document).toContain('Resolution: Fixed');
    expect(document).toContain('Created: 2026-08-11');
    expect(document).toContain('Components: Pharmacy');
  });

  it('keeps everything when no screen is known', () => {
    // A failed metadata call must not silently shrink the document.
    const document = jiraDocument(
      issue({ summary: 'S', customfield_10744: { value: 'Broadcast' } }),
      { customfield_10744: 'Type of Engagement' }
    );
    expect(document).toContain('Type of Engagement: Broadcast');
  });

  it('indexes logged time in the form a person reads', () => {
    // The seconds counters are skipped as noise; this is the half that means
    // something, and it was being dropped with them.
    const document = jiraDocument(
      issue({
        summary: 'S',
        timetracking: { timeSpent: '45m', remainingEstimate: '0m', timeSpentSeconds: 2700 },
      }),
      { timetracking: 'Time tracking' }
    );
    expect(document).toContain('Time tracking: 45m logged, 0m remaining');
    expect(document).not.toContain('2700');
  });
});
