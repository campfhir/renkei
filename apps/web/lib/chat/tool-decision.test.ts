import { decideTool, decidedBy, emptyLayers, type ToolLayers } from './tool-decision';

const set = (...names: string[]) => new Set(names);

/** Layers built from a sketch: only what a case sets. */
function layers(sketch: {
  locked?: string[];
  userAllow?: string[];
  userDeny?: string[];
  project?: { allow?: string[]; ask?: string[] };
  sessionAllow?: string[];
  sessionDeny?: string[];
  sessionAsk?: string[];
  autoHighRisk?: string[];
}): ToolLayers {
  return {
    ...emptyLayers(),
    locked: set(...(sketch.locked ?? [])),
    user: { allow: set(...(sketch.userAllow ?? [])), deny: set(...(sketch.userDeny ?? [])) },
    project: sketch.project
      ? { allow: set(...(sketch.project.allow ?? [])), ask: set(...(sketch.project.ask ?? [])) }
      : null,
    session: {
      allow: set(...(sketch.sessionAllow ?? [])),
      deny: set(...(sketch.sessionDeny ?? [])),
      ask: set(...(sketch.sessionAsk ?? [])),
    },
    auto: sketch.autoHighRisk
      ? { highRisk: (name) => (sketch.autoHighRisk ?? []).includes(name) }
      : null,
  };
}

describe('a tool call in a chat', () => {
  it('with nothing set: a read tool runs, an act tool asks', () => {
    expect(decideTool(emptyLayers(), 'jira_search', 'read')).toBe('run');
    expect(decideTool(emptyLayers(), 'jira_create_issue', 'act')).toBe('ask');
  });

  it('a block — here or always — refuses, and nothing lifts it', () => {
    const blocked = layers({
      sessionDeny: ['jira_create_issue'],
      userDeny: ['jira_search'],
      sessionAllow: ['jira_search'],
      project: { allow: ['jira_create_issue'] },
      userAllow: ['jira_create_issue'],
    });
    expect(decideTool(blocked, 'jira_create_issue', 'act')).toBe('refuse');
    // Always blocked for this kind of session; allowing it here does not override that.
    expect(decideTool(blocked, 'jira_search', 'read')).toBe('refuse');
  });

  it('an organization-locked tool asks — a read tool too — whatever is allowed', () => {
    const locked = layers({
      locked: ['outlook_send_mail', 'outlook_list_mail'],
      sessionAllow: ['outlook_send_mail'],
      project: { allow: ['outlook_send_mail'] },
      userAllow: ['outlook_send_mail'],
    });
    expect(decideTool(locked, 'outlook_send_mail', 'act')).toBe('ask');
    expect(decideTool(locked, 'outlook_list_mail', 'read')).toBe('ask');
    // But a block still refuses it.
    expect(
      decideTool(
        layers({ locked: ['outlook_send_mail'], sessionDeny: ['outlook_send_mail'] }),
        'outlook_send_mail',
        'act'
      )
    ).toBe('refuse');
  });

  it('this chat can make a read tool ask, and let an act tool run without asking', () => {
    const chat = layers({ sessionAsk: ['jira_search'], sessionAllow: ['jira_create_issue'] });
    expect(decideTool(chat, 'jira_search', 'read')).toBe('ask');
    expect(decideTool(chat, 'jira_create_issue', 'act')).toBe('run');
  });

  it('a project’s Allow runs in its chats unless the chat says Ask or blocks it', () => {
    const project = { allow: ['jira_create_issue'], ask: ['jira_search'] };
    expect(decideTool(layers({ project }), 'jira_create_issue', 'act')).toBe('run');
    expect(decideTool(layers({ project }), 'jira_search', 'read')).toBe('ask');
    expect(
      decideTool(layers({ project, sessionAsk: ['jira_create_issue'] }), 'jira_create_issue', 'act')
    ).toBe('ask');
    expect(
      decideTool(
        layers({ project, sessionDeny: ['jira_create_issue'] }),
        'jira_create_issue',
        'act'
      )
    ).toBe('refuse');
  });

  it('the person’s always-allow runs an act tool; the project’s Ask holds it back', () => {
    expect(decideTool(layers({ userAllow: ['card_create'] }), 'card_create', 'act')).toBe('run');
    expect(
      decideTool(
        layers({ userAllow: ['card_create'], project: { ask: ['card_create'] } }),
        'card_create',
        'act'
      )
    ).toBe('ask');
  });

  it('Auto mode in a code project: undecided act tools run, unless the person marks them high risk', () => {
    const auto = layers({ autoHighRisk: ['github_merge_pull_request'] });
    expect(decideTool(auto, 'code_git_push', 'act')).toBe('run');
    expect(decideTool(auto, 'github_merge_pull_request', 'act')).toBe('ask');
    // The organization's lock asks in Auto mode too, and a block still refuses.
    expect(
      decideTool(layers({ autoHighRisk: [], locked: ['code_git_push'] }), 'code_git_push', 'act')
    ).toBe('ask');
    expect(
      decideTool(layers({ autoHighRisk: [], userDeny: ['code_git_push'] }), 'code_git_push', 'act')
    ).toBe('refuse');
    // A decision for the tool beats the Auto default: this chat's Ask holds it back.
    expect(
      decideTool(
        layers({ autoHighRisk: [], sessionAsk: ['code_git_push'] }),
        'code_git_push',
        'act'
      )
    ).toBe('ask');
  });

  it('says which layer decided, for the rows that explain it', () => {
    const all = layers({
      sessionDeny: ['a'],
      userDeny: ['b'],
      locked: ['c'],
      sessionAsk: ['d'],
      sessionAllow: ['e'],
      project: { ask: ['f'], allow: ['g'] },
      userAllow: ['h'],
    });
    expect(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'z'].map((name) => decidedBy(all, name))
    ).toEqual([
      'blocked-here',
      'always-blocked',
      'locked',
      'ask-here',
      'allowed-here',
      'project-ask',
      'project-allow',
      'always-allowed',
      'default',
    ]);
  });
});
