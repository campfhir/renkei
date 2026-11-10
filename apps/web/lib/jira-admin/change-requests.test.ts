/**
 * Who may open a Jira admin change request's review page (`mayView`, which
 * the page answers not-found by): the person who asked and any operator,
 * nobody else. jira-admin-changes.spec.ts opened someone else's request
 * as a person without the role to see this; the routes' own refusals are
 * the apply and cancel route tests, and the store's are
 * change-requests.db.test.ts.
 */

import { mayView } from './change-requests';

const change = { subject: 'sam@example.com' };

describe('who may see a change request', () => {
  it('the person who asked sees their own', () => {
    expect(mayView(change, { subject: 'sam@example.com', operator: false })).toBe(true);
  });

  it('an operator sees anyone’s', () => {
    expect(mayView(change, { subject: 'olive@example.com', operator: true })).toBe(true);
  });

  it('a person who is not an operator does not see someone else’s', () => {
    expect(mayView(change, { subject: 'ola@example.com', operator: false })).toBe(false);
  });
});
