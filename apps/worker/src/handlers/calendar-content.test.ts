/**
 * What a calendar invite looks like by the time it is embedded.
 *
 * Graph hands back HTML, and a meeting invite is mostly join links — each
 * wrapped in a safelinks envelope carrying a few hundred characters of
 * percent-encoding. Embedded raw, a chunk is more URL escape than meaning,
 * which is both a waste of the chunk budget and actively misleading to a
 * vector search.
 */

import { cleanInviteBody, normalizeBody } from '@renkei/email-sanitizer';

/** The same reduction microsoft-sync applies before embedding. */
function readable(content: string, contentType: 'html' | 'text'): string {
  return cleanInviteBody(normalizeBody({ content, contentType }));
}

describe('calendar body cleaning', () => {
  it('unwraps a safelinks-wrapped join URL back to the real one', () => {
    const wrapped =
      'https://nam11.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%3Ameeting_abc&data=05%7C02%7C&sdata=qGIzTbkM9S0Ae7AkShnVATE2ixMmsv3uzCTrp4x3sbU%3D&reserved=0';
    const cleaned = readable(`<p>Join here: <a href="${wrapped}">Click</a> ${wrapped}</p>`, 'html');
    expect(cleaned).toContain('teams.microsoft.com');
    // The envelope and its payload are gone, not merely shortened.
    expect(cleaned).not.toContain('safelinks.protection.outlook.com');
    expect(cleaned).not.toContain('sdata=');
  });

  it('turns invite HTML into text a person could read', () => {
    const html =
      '<div><b>Weekly sync</b><br/>Agenda:<ul><li>Roadmap</li><li>Budget</li></ul></div>';
    const cleaned = readable(html, 'html');
    expect(cleaned).toContain('Weekly sync');
    expect(cleaned).toContain('Roadmap');
    // No markup survives into the embedding.
    expect(cleaned).not.toContain('<');
  });

  it('leaves a plain-text body alone apart from tidying', () => {
    expect(readable('Standup at 9.\n\nBring numbers.', 'text')).toContain('Standup at 9.');
  });
});

describe('invite chrome', () => {
  it('drops the Teams block that is identical in every invite, keeping the coordinates', () => {
    const html =
      '<div>Cutover review — bring the rollback plan.<br>' +
      '<hr>Microsoft Teams<br>Need help?<br>Join the meeting now<br>' +
      'Meeting ID: 231 998 447 102<br>Passcode: Kd7pQ2<br>' +
      'Find a local number<br>For organizers: Meeting options | Reset dial-in PIN</div>';
    const cleaned = readable(html, 'html');
    expect(cleaned).toContain('bring the rollback plan');
    expect(cleaned).toContain('231 998 447 102');
    expect(cleaned).toContain('Kd7pQ2');
    expect(cleaned).not.toContain('Need help?');
    expect(cleaned).not.toContain('Find a local number');
    expect(cleaned).not.toContain('For organizers');
  });
});
