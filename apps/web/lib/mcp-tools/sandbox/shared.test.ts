import type { MCPToolContext } from '../common';
import { targetOf } from './shared';

const base: MCPToolContext = {
  accountId: '',
  siteUrl: '',
  apiBaseUrl: '',
  jiraAuth: null,
  maxJqlResults: 100,
  subject: 'auth0|alice',
};

describe('targetOf', () => {
  it('stages in the scratch space the caller’s token names', () => {
    expect(targetOf({ ...base, sandboxScope: 'project:p1' })).toEqual({
      subject: 'auth0|alice',
      scope: 'project:p1',
    });
  });

  it('is the person’s own scratch space for a token that names none', () => {
    expect(targetOf(base)).toEqual({ subject: 'auth0|alice' });
  });

  it('a person’s own call goes by their own instance assignment: it names no other', () => {
    expect(targetOf({ ...base, sandboxScope: 'chat:c1' })).not.toHaveProperty('route');
  });

  it('an agent’s call is still its owner’s — their scratch space and identity — but goes by the agent’s own assignment', () => {
    expect(targetOf({ ...base, agent: { agentId: 'agent-7' } })).toEqual({
      subject: 'auth0|alice',
      route: 'agent:agent-7',
    });
    expect(targetOf({ ...base, sandboxScope: 'chat:c1', agent: { agentId: 'agent-7' } })).toEqual({
      subject: 'auth0|alice',
      scope: 'chat:c1',
      route: 'agent:agent-7',
    });
  });

  it('two agents of one person go by two assignments', () => {
    const one = targetOf({ ...base, agent: { agentId: 'agent-1' } });
    const two = targetOf({ ...base, agent: { agentId: 'agent-2' } });
    expect(typeof one === 'object' && one.route).toBe('agent:agent-1');
    expect(typeof two === 'object' && two.route).toBe('agent:agent-2');
  });

  it('refuses a request with no identity', () => {
    expect(typeof targetOf({ ...base, subject: undefined })).toBe('string');
  });
});
