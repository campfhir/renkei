/**
 * The shipped default classifier rules, checked against real-world sender
 * shapes. The asymmetry that matters: a FALSE POSITIVE here refiles a
 * colleague's email as machine noise and buries it, while a false negative
 * merely leaves noise indexed. So the "does not misfire" cases are the
 * point of this file, not an afterthought.
 */

import { classify } from '../classify';
import { DEFAULT_CLASSIFIER_RULES } from './seed';
import type { ClassifierRule } from '../types';

/** The shipped defaults as the classifier consumes them. */
const RULES: ClassifierRule[] = DEFAULT_CLASSIFIER_RULES.map((rule, index) => ({
  id: `default-${index}`,
  category: rule.category,
  matchType: rule.matchType,
  matchValue: rule.matchValue,
  senderKey: rule.senderKey,
  priority: rule.priority,
  enabled: true,
}));

const classifyMail = (email: Parameters<typeof classify>[1]) => classify(RULES, email);

describe('default rules catch machine senders', () => {
  it.each([
    ['no-reply@zoom.us', 'the Zoom recap from the screenshot that started this'],
    ['noreply@github.com', 'unhyphenated spelling on a domain that also carries human mail'],
    ['DoNotReply@microsoft.com', 'mixed case must still match'],
    ['notifications@slack.com', 'reserved notification mailbox'],
    ['mailer-daemon@example.org', 'bounce notices'],
  ])('classifies %s as a system notification (%s)', (fromAddress) => {
    const result = classifyMail({ fromAddress, subject: 'anything' });
    expect(result.category).toBe('system_notification');
  });

  it('catches SharePoint share notices that impersonate a colleague', () => {
    // Every visible header says a real person; only the Message-ID gives it away.
    const result = classifyMail({
      fromAddress: 'murali.athuluri@nems.org',
      subject: 'Murali shared a file with you',
      replyToAddress: 'murali.athuluri@nems.org',
      messageId: '<abc123@odspnotify>',
    });
    expect(result.category).toBe('system_notification');
    expect(result.senderKey).toBe('sharepoint');
  });

  it('classifies zoom.us mail by domain even without a no-reply local part', () => {
    const result = classifyMail({ fromAddress: 'meetings@zoom.us', subject: 'Your recording' });
    expect(result.category).toBe('system_notification');
    expect(result.senderKey).toBe('zoom');
  });
});

describe('default rules do NOT misfire on real correspondence', () => {
  it.each([
    ['lucinda.gardner@nems.org', 'an ordinary colleague'],
    ['scott@example.com', 'a plain external address'],
    ['dana.reply@example.com', 'contains "reply" but is not a no-reply address'],
    ['no.replyman@example.com', 'contains "no" and "reply" but no "no-reply@"'],
    ['notifications.team@example.com', 'a human TEAM alias — the @ anchor is what saves this'],
  ])('leaves %s as human correspondence (%s)', (fromAddress) => {
    const result = classifyMail({ fromAddress, subject: 'RE: Students Recorded in Paycom?' });
    expect(result.category).toBe('human');
  });

  it('does not treat a person at a vendor domain as machine mail', () => {
    // atlassian.com carries both; only automation.atlassian.com is filed.
    const result = classifyMail({
      fromAddress: 'a.person@atlassian.com',
      subject: 'About your renewal',
    });
    expect(result.category).toBe('human');
  });

  it('leaves mail with no headers at all as human — the fail-safe default', () => {
    expect(classifyMail({ fromAddress: '', subject: '' }).category).toBe('human');
  });
});

describe('the shipped list itself', () => {
  it('never ships a marketing rule, which would exclude mail from indexing', () => {
    // Marketing is dropped entirely, so a default rule with that category
    // could silently destroy real mail. Any future addition must be a
    // deliberate, separately-reviewed decision.
    expect(DEFAULT_CLASSIFIER_RULES.filter((rule) => rule.category === 'marketing')).toEqual([]);
  });

  it('anchors every local-part rule with @, so it cannot match mid-address', () => {
    const localPartRules = DEFAULT_CLASSIFIER_RULES.filter(
      (rule) => rule.matchType === 'sender_email_contains'
    );
    expect(localPartRules.length).toBeGreaterThan(0);
    for (const rule of localPartRules) {
      expect(rule.matchValue.endsWith('@')).toBe(true);
    }
  });

  it('has unique match targets, so no rule shadows another', () => {
    const keys = DEFAULT_CLASSIFIER_RULES.map((rule) => `${rule.matchType} ${rule.matchValue}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
