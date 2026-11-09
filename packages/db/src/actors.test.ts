/**
 * Who a log line names: a person by name, email and id together; an agent
 * by its name and the person it runs as. Nothing here may throw, and nothing
 * here may hit the store twice for the same person inside the cache window.
 */

import {
  actorFrom,
  actorFields,
  agentFields,
  describeActor,
  describeAccountActor,
  describeAgent,
  agentAttrsFor,
  forgetActor,
  resetActorCache,
} from './actors';
import { createMemoryDataStore } from './store/memory';
import { registerDataStore, resetDataStore } from './store/registry';

const definition = {
  instructions: 'do the thing',
  tools: [],
  llmModelId: null,
  enabled: true,
  guardrails: null,
  canAskQuestions: false,
  autoAcceptActions: false,
};

describe('describing people for logs', () => {
  let store: ReturnType<typeof createMemoryDataStore>;

  beforeEach(() => {
    store = createMemoryDataStore();
    registerDataStore(store);
    resetActorCache();
  });
  afterEach(() => resetDataStore());

  it('names a signed-in person by display name, email and subject', async () => {
    await store.identities.upsert({
      subject: 'auth0|ada',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      idpGroups: [],
    });
    const actor = await describeActor('auth0|ada');
    expect(actor).toEqual({
      subject: 'auth0|ada',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      label: 'Ada Lovelace (ada@example.com)',
    });
    expect(actorFields(actor)).toEqual({
      subject: 'auth0|ada',
      user: 'Ada Lovelace',
      email: 'ada@example.com',
      actor: 'Ada Lovelace (ada@example.com)',
    });
  });

  it('falls back to the email when no name is recorded, and to the subject when nothing is', async () => {
    await store.identities.upsert({
      subject: 'auth0|bob',
      email: 'bob@example.com',
      displayName: null,
      idpGroups: [],
    });
    expect(await describeActor('auth0|bob')).toEqual({
      subject: 'auth0|bob',
      displayName: 'bob@example.com',
      email: 'bob@example.com',
      label: 'bob@example.com',
    });
    expect(await describeActor('auth0|stranger')).toEqual({
      subject: 'auth0|stranger',
      displayName: 'auth0|stranger',
      email: null,
      label: 'auth0|stranger',
    });
    expect(await describeActor(null)).toEqual({
      subject: '(none)',
      displayName: '(none)',
      email: null,
      label: '(none)',
    });
  });

  it('reads an identity once inside the cache window, and again after it is forgotten', async () => {
    const get = jest.spyOn(store.identities, 'get');
    await describeActor('auth0|ada');
    await describeActor('auth0|ada');
    expect(get).toHaveBeenCalledTimes(1);
    forgetActor('auth0|ada');
    await describeActor('auth0|ada');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('still answers, with the id, when the identity read fails', async () => {
    jest.spyOn(store.identities, 'get').mockRejectedValue(new Error('down'));
    expect((await describeActor('auth0|ada')).label).toBe('auth0|ada');
  });

  it('names the person behind a provider account through their grant', async () => {
    await store.identities.upsert({
      subject: 'auth0|ada',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      idpGroups: [],
    });
    await store.providerGrants.upsertSealed('atlassian', {
      accountId: 'acc-1',
      clientId: 'client',
      displayName: 'ada (jira)',
      subject: 'auth0|ada',
      encryptedAccessToken: 'sealed-access',
      encryptedRefreshToken: 'sealed-refresh',
      keepStoredRefreshToken: false,
      expiresAt: new Date(Date.now() + 3_600_000),
      requestedScopes: [],
      grantedScopes: null,
      metadata: {},
    });
    expect((await describeAccountActor('acc-1')).label).toBe('Ada Lovelace (ada@example.com)');
  });

  it('builds a label without repeating an email used as the name', () => {
    expect(actorFrom('s', null, 'x@y.z').label).toBe('x@y.z');
    expect(actorFrom('s', 'X', null).label).toBe('X');
    expect(actorFrom('s', 'X', 'x@y.z').label).toBe('X (x@y.z)');
  });
});

describe('describing agents for logs', () => {
  let store: ReturnType<typeof createMemoryDataStore>;

  beforeEach(async () => {
    store = createMemoryDataStore();
    registerDataStore(store);
    resetActorCache();
    await store.identities.upsert({
      subject: 'auth0|ada',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      idpGroups: [],
    });
    await store.agents.create({
      id: 'agent-1',
      ownerSubject: 'auth0|ada',
      name: 'Nightly digest',
      ...definition,
    });
  });
  afterEach(() => resetDataStore());

  it('names the agent and the person it runs as', async () => {
    const agent = await describeAgent('agent-1');
    expect(agent.agentName).toBe('Nightly digest');
    expect(agent.owner.label).toBe('Ada Lovelace (ada@example.com)');
    expect(agentFields(agent)).toEqual({
      agentId: 'agent-1',
      agent: 'Nightly digest',
      ownerSubject: 'auth0|ada',
      ownerName: 'Ada Lovelace',
      ownerEmail: 'ada@example.com',
      owner: 'Ada Lovelace (ada@example.com)',
    });
  });

  it('logs a deleted agent as unknown rather than not at all', async () => {
    const agent = await describeAgent('agent-gone');
    expect(agent).toEqual({
      agentId: 'agent-gone',
      agentName: '(unknown agent)',
      owner: { subject: '(none)', displayName: '(none)', email: null, label: '(none)' },
    });
  });

  it('skips the agent read when the row in hand already names the agent', async () => {
    const find = jest.spyOn(store.agents, 'find');
    const fields = await agentAttrsFor({
      agentId: 'agent-1',
      agentName: 'Nightly digest',
      ownerSubject: 'auth0|ada',
    });
    expect(find).not.toHaveBeenCalled();
    expect(fields.owner).toBe('Ada Lovelace (ada@example.com)');
  });
});
