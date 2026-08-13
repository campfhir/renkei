/**
 * The classifier's contract: issue-shaped messages become an executable
 * jira_create_issue suggestion; everything else becomes nothing. The output's
 * args must be executable verbatim — that is the pipeline's promise.
 */

import { classifyMessage } from './classify';

describe('classifyMessage', () => {
  it('turns an issue report into a jira_create_issue suggestion', () => {
    const result = classifyMessage(
      'Login page is broken again\nUsers get a timeout after entering credentials.'
    );

    expect(result).not.toBeNull();
    expect(result?.title).toContain('Login page is broken again');
    expect(result?.suggestedAction.tool).toBe('jira_create_issue');
    expect(result?.suggestedAction.args.summary).toBe('Login page is broken again');
    expect(result?.suggestedAction.args.description).toContain('> Login page is broken again');
    expect(result?.suggestedAction.args.issueType).toBe('Task');
  });

  it("normalizes contractions: can't counts as cannot", () => {
    expect(classifyMessage("I can't open the Q4 report")).not.toBeNull();
  });

  it('returns null for chatter with no issue signal', () => {
    expect(classifyMessage('Lunch at noon? The new place on 5th has great ramen.')).toBeNull();
    expect(classifyMessage('Thanks, merged your change!')).toBeNull();
  });

  it('does not match signal words inside other words', () => {
    expect(classifyMessage('Handed out tissues at the standup.')).toBeNull();
  });

  it('returns null for empty or whitespace text', () => {
    expect(classifyMessage('')).toBeNull();
    expect(classifyMessage('   \n ')).toBeNull();
  });

  it('clips long headlines to a sane summary length', () => {
    const long = `The deployment pipeline is failing ${'x'.repeat(200)}`;
    const result = classifyMessage(long);
    expect(result?.suggestedAction.args.summary.length).toBeLessThanOrEqual(80);
  });
});
