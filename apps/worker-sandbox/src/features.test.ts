jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));

import { decideScriptsFor, orgSandboxFeatures, NO_ORG_FEATURES } from './features';

const { getOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>('@renkei/settings');

describe('the per-request decision for scripts', () => {
  it('serves isolated runs whichever way the namespace is made, whatever the org allows', () => {
    for (const mode of ['netns', 'userns'] as const) {
      for (const scriptsAllowNetwork of [false, true]) {
        expect(decideScriptsFor('isolated', mode, { scripts: true, scriptsAllowNetwork })).toEqual({
          serve: true,
          networkShared: false,
        });
      }
    }
  });

  it('closes the verb when no isolation works and the organization has not opted in', () => {
    const decision = decideScriptsFor('network_only', null, {
      scripts: true,
      scriptsAllowNetwork: false,
    });
    expect(decision.serve).toBe(false);
    expect(!decision.serve && decision.message).toMatch(
      /cannot start a script without network access/
    );
  });

  it('serves runs on the container’s network only with the organization’s opt-in, and says so', () => {
    expect(
      decideScriptsFor('network_only', null, { scripts: true, scriptsAllowNetwork: true })
    ).toEqual({ serve: true, networkShared: true });
  });

  it('is simply off for an organization that has not turned scripts on, whatever else is true', () => {
    const decision = decideScriptsFor('isolated', 'netns', {
      scripts: false,
      scriptsAllowNetwork: true,
    });
    expect(decision).toEqual({ serve: false, message: expect.stringMatching(/not enabled/) });
  });

  it('cannot serve without an interpreter', () => {
    const decision = decideScriptsFor('none', 'netns', {
      scripts: true,
      scriptsAllowNetwork: true,
    });
    expect(decision.serve).toBe(false);
    expect(!decision.serve && decision.message).toMatch(/no Python interpreter/);
  });
});

describe('an organization’s sandbox switches', () => {
  beforeEach(() => getOrgSettings.mockReset());

  it('come from its settings, with services needing workspaces', async () => {
    getOrgSettings.mockResolvedValue({
      ok: true,
      val: {
        sandboxBrowserEnabled: true,
        sandboxChartsEnabled: false,
        sandboxWorkspacesEnabled: false,
        sandboxServicesEnabled: true,
        sandboxScriptsEnabled: true,
        sandboxScriptsAllowNetwork: false,
      },
    });
    expect(await orgSandboxFeatures()).toEqual({
      browser: true,
      charts: false,
      workspaces: false,
      services: false,
      scripts: true,
      scriptsAllowNetwork: false,
    });
    expect(getOrgSettings).toHaveBeenCalledWith('tenant-1');
  });

  it('are all off when the settings cannot be read', async () => {
    getOrgSettings.mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    expect(await orgSandboxFeatures()).toEqual(NO_ORG_FEATURES);
  });
});
