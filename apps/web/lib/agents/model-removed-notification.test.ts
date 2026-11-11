import { modelRemovedHeadline, modelRemovedUses } from './model-removed-notification';

const none = { preference: false, projects: 0, chats: 0, agents: 0 };

describe('the "your model changed" note', () => {
  it('names what was removed, what replaced it and for what of theirs', () => {
    expect(
      modelRemovedHeadline({
        label: 'Fable',
        replacementLabel: 'Opus',
        preference: true,
        projects: 2,
        chats: 3,
        agents: 1,
      })
    ).toBe(
      'An administrator removed the model "Fable". "Opus" replaced it for your preferred chat model, 2 projects, 3 chats and 1 agent.'
    );
  });

  it('counts one thing as one thing, and leaves out what was not touched', () => {
    expect(
      modelRemovedHeadline({ ...none, label: 'Fable', replacementLabel: 'Opus', chats: 1 })
    ).toBe('An administrator removed the model "Fable". "Opus" replaced it for 1 chat.');
    expect(
      modelRemovedHeadline({
        ...none,
        label: 'Fable',
        replacementLabel: 'Opus',
        preference: true,
        agents: 2,
      })
    ).toBe(
      'An administrator removed the model "Fable". "Opus" replaced it for your preferred chat model and 2 agents.'
    );
  });

  it("says the organization's default when no replacement was picked", () => {
    expect(
      modelRemovedHeadline({ ...none, label: 'Fable', replacementLabel: null, preference: true })
    ).toBe(
      'An administrator removed the model "Fable". The organization\'s default model replaced it for your preferred chat model.'
    );
  });
});

describe('who a removal touches', () => {
  it('joins who prefers the model with whose things were set to it, by subject', () => {
    expect(
      modelRemovedUses(
        [
          { subject: 'bob', projects: 1, chats: 0, agents: 0 },
          { subject: 'ann', projects: 0, chats: 2, agents: 1 },
        ],
        ['cat', 'ann']
      )
    ).toEqual([
      { subject: 'ann', projects: 0, chats: 2, agents: 1, preference: true },
      { subject: 'bob', projects: 1, chats: 0, agents: 0, preference: false },
      { subject: 'cat', projects: 0, chats: 0, agents: 0, preference: true },
    ]);
  });
});
