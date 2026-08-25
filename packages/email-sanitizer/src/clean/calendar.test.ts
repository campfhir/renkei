/**
 * The tests that matter here are the two failure directions: chrome that
 * survives (every invite looks alike) and coordinates that don't (the chunk
 * can no longer answer "how do I join?"). Both are checked on the same
 * realistic invite rather than on isolated lines.
 */

import { cleanInviteBody, stripConferencingBoilerplate } from './calendar';

const TEAMS_INVITE = [
  'Hi all — agenda is the pharmacy migration cutover and the on-call rota.',
  '',
  '________________________________________________________________________',
  'Microsoft Teams',
  'Need help?',
  'Join the meeting now',
  'Meeting ID: 123 456 789 012',
  'Passcode: aB3xY9',
  '',
  'Dial in by phone',
  '+1 323-555-0100,,472910384# United States, Los Angeles',
  'Find a local number',
  'Reset dial-in PIN',
  '',
  'For organizers: Meeting options | Reset dial-in PIN',
  '________________________________________________________________________',
].join('\n');

describe('stripConferencingBoilerplate', () => {
  const cleaned = stripConferencingBoilerplate(TEAMS_INVITE);

  it('keeps what someone needs in order to join', () => {
    expect(cleaned).toContain('Meeting ID: 123 456 789 012');
    expect(cleaned).toContain('Passcode: aB3xY9');
    expect(cleaned).toContain('+1 323-555-0100,,472910384#');
  });

  it('keeps the human agenda, which is the whole reason to index an invite', () => {
    expect(cleaned).toContain('pharmacy migration cutover');
  });

  it('drops the instructional chrome that is identical in every invite', () => {
    expect(cleaned).not.toContain('Need help?');
    expect(cleaned).not.toContain('Join the meeting now');
    expect(cleaned).not.toContain('Find a local number');
    expect(cleaned).not.toContain('For organizers');
    expect(cleaned).not.toMatch(/^_{6,}$/m);
  });

  it('cuts an invite down to a fraction of its length', () => {
    // Not a cosmetic threshold: chrome outweighing content is exactly what
    // makes every meeting embed alike.
    expect(cleaned.length).toBeLessThan(TEAMS_INVITE.length / 2);
  });

  it('never drops a line carrying a link, however chrome-like it reads', () => {
    const withLink = 'Join the meeting now https://teams.microsoft.com/l/meetup-join/abc';
    expect(stripConferencingBoilerplate(withLink)).toContain('teams.microsoft.com');
  });

  it('leaves a human sentence alone even when it uses the same words', () => {
    const prose = 'I changed the meeting options so guests can join the meeting now.';
    expect(stripConferencingBoilerplate(prose)).toBe(prose);
  });

  it('strips Zoom and Webex chrome as well as Teams', () => {
    const other = [
      'Join Zoom Meeting',
      'https://zoom.us/j/98765432101',
      'One tap mobile',
      'Dial by your location',
      'Find your local number:',
      'Global call-in numbers | Toll-free calling restrictions',
    ].join('\n');
    const result = stripConferencingBoilerplate(other);
    expect(result).toContain('zoom.us/j/98765432101');
    expect(result).not.toContain('One tap mobile');
    expect(result).not.toContain('Dial by your location');
    expect(result).not.toContain('Global call-in numbers');
  });
});

describe('cleanInviteBody', () => {
  it('applies the shared mail rules too — a legal footer is not invite-specific', () => {
    const body = [
      'Agenda: cutover checklist.',
      '',
      'CONFIDENTIALITY NOTICE: This e-mail and any attachments are confidential',
      'and intended solely for the addressee. If you have received this in error',
      'please notify the sender and delete it.',
    ].join('\n');
    const cleaned = cleanInviteBody(body);
    expect(cleaned).toContain('cutover checklist');
    expect(cleaned).not.toContain('CONFIDENTIALITY NOTICE');
  });

  it('unwraps gateway-wrapped join links on the way through', () => {
    const body =
      'Join: https://nam11.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2Fabc&data=05%7C02';
    const cleaned = cleanInviteBody(body);
    expect(cleaned).toContain('teams.microsoft.com');
    expect(cleaned).not.toContain('safelinks');
  });
});
