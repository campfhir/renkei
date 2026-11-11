import { modalTitle, panelFor, projectHostOf } from './pipelines-modal.model';

const view = (code: unknown, role = 'owner') => ({ role, code });

describe('which panel a project gets', () => {
  it('reads the host, repository and branch off the project', () => {
    expect(
      projectHostOf(view({ repoProvider: 'github', repoFullName: 'acme/demo', branch: 'main' }))
    ).toEqual({ provider: 'github', repoFullName: 'acme/demo', branch: 'main', canEdit: true });
  });

  it('an editor changes the setup and a viewer only reads it', () => {
    const code = { repoProvider: 'atlassian-bitbucket', repoFullName: 'w/r', branch: '' };
    expect(projectHostOf(view(code, 'editor'))?.canEdit).toBe(true);
    expect(projectHostOf(view(code, 'viewer'))?.canEdit).toBe(false);
  });

  it('a project that names no repository has no panel', () => {
    expect(projectHostOf(null)).toBeNull();
    expect(projectHostOf({ role: 'owner' })).toBeNull();
    expect(projectHostOf(view({ repoProvider: 'github', repoFullName: '' }))).toBeNull();
  });

  it('is titled for the host: Actions on GitHub, Pipelines otherwise', () => {
    expect(modalTitle({ provider: 'github', repoFullName: 'a/b', branch: '', canEdit: true })).toBe(
      'Actions'
    );
    expect(
      modalTitle({
        provider: 'atlassian-bitbucket',
        repoFullName: 'a/b',
        branch: '',
        canEdit: true,
      })
    ).toBe('Pipelines');
    expect(modalTitle(null)).toBe('Pipelines');
  });

  it('has a panel for GitHub and Bitbucket only', () => {
    const target = (provider: string) => ({
      provider,
      repoFullName: 'a/b',
      branch: '',
      canEdit: true,
    });
    expect(panelFor(target('github'))).toBe('actions');
    expect(panelFor(target('atlassian-bitbucket'))).toBe('pipelines');
    expect(panelFor(target('gitlab'))).toBeNull();
  });
});
