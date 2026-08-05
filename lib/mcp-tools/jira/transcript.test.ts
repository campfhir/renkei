import { analyzeTranscript, formatActionsAsMarkdown } from './transcript';

const forTool = (transcript: string, tool: string, options = {}) =>
  analyzeTranscript(transcript, options).filter((action) => action.tool === tool);

describe('analyzeTranscript', () => {
  it('finds nothing in empty or unremarkable input', () => {
    expect(analyzeTranscript('')).toEqual([]);
    expect(analyzeTranscript('   ')).toEqual([]);
    expect(analyzeTranscript('We talked about the weather and then adjourned.')).toEqual([]);
  });

  describe('issue creation', () => {
    it('picks up the summary and the issue type from the noun used', () => {
      const [action] = forTool('Can we create a bug for the login timeout?', 'create_issue');
      expect(action?.arguments.issueType).toBe('Bug');
      expect(action?.arguments.summary).toBe('the login timeout');
    });

    it('defaults to Task and quotes the transcript in the description', () => {
      const [action] = forTool('We need to create a task: rotate the signing keys', 'create_issue');
      expect(action?.arguments.issueType).toBe('Task');
      expect(action?.arguments.summary).toBe('rotate the signing keys');
      expect(action?.arguments.description).toContain('rotate the signing keys');
    });

    it('fills in the project when given one, and is honest when not', () => {
      const [withProject] = forTool('create a task: ship it', 'create_issue', {
        projectKey: 'CHG',
      });
      expect(withProject?.arguments.projectKey).toBe('CHG');
      expect(withProject?.confidence).toBe('high');

      const [without] = forTool('create a task: ship it', 'create_issue');
      expect(without?.arguments).not.toHaveProperty('projectKey');
      expect(without?.confidence).toBe('medium');
      expect(without?.summary).toContain('project not named');
    });
  });

  describe('assignment', () => {
    it('reads "assign KEY to person"', () => {
      const [action] = forTool('Please assign CHG-20 to dana.lin', 'update_issue');
      expect(action?.arguments).toEqual({ issueKey: 'CHG-20', assignee: 'dana.lin' });
      expect(action?.confidence).toBe('high');
    });

    it('reads "person will handle KEY", in either order', () => {
      const [action] = forTool('dana will handle CHG-21 this sprint', 'update_issue');
      expect(action?.arguments).toEqual({ issueKey: 'CHG-21', assignee: 'dana' });
    });

    it('reads an "assign: person for KEY" line', () => {
      const [action] = forTool('assign: sam@x.test for ENG-5', 'update_issue');
      expect(action?.arguments).toEqual({ issueKey: 'ENG-5', assignee: 'sam@x.test' });
    });

    it('works for any project key, not just SCRUM', () => {
      // The original patterns hardcoded SCRUM and captured no key, so this
      // produced nothing at all.
      const keys = forTool('assign ABC_9-1234 to dana', 'update_issue').map(
        (action) => action.arguments.issueKey
      );
      expect(keys).toEqual(['ABC_9-1234']);
    });
  });

  describe('transitions', () => {
    it('normalises a spoken status to a Jira name', () => {
      const [action] = forTool('move CHG-20 to in progress', 'transition_issue');
      expect(action?.arguments).toEqual({ issueKey: 'CHG-20', transitionName: 'In Progress' });
      expect(action?.confidence).toBe('high');
    });

    it('recommends a name rather than an instance-specific id', () => {
      const [action] = forTool('mark CHG-20 as done', 'transition_issue');
      expect(action?.arguments).toHaveProperty('transitionName');
      expect(action?.arguments).not.toHaveProperty('transitionId');
    });

    it('infers status from starting and finishing', () => {
      const [started] = forTool('I will start work on CHG-22 today', 'transition_issue');
      expect(started?.arguments.transitionName).toBe('In Progress');

      const [finished] = forTool('We finished CHG-23', 'transition_issue');
      expect(finished?.arguments.transitionName).toBe('Done');
    });

    it('drops confidence and says so for a status it cannot verify', () => {
      const [action] = forTool('move CHG-20 to pending signoff', 'transition_issue');
      expect(action?.confidence).toBe('low');
      expect(action?.summary).toContain('list_transitions');
      expect(action?.arguments.transitionName).toBe('pending signoff');
    });
  });

  describe('pronoun targets', () => {
    it('resolves "this" from the issue under discussion', () => {
      const [action] = forTool('assign this to dana', 'update_issue', { issueKey: 'CHG-20' });
      expect(action?.arguments.issueKey).toBe('CHG-20');
      expect(action?.confidence).toBe('medium');
      expect(action?.summary).toContain('referred to as "this"');
    });

    it('reports the action without a key when there is nothing to resolve to', () => {
      const [action] = forTool('assign this to dana', 'update_issue');
      expect(action?.arguments).not.toHaveProperty('issueKey');
      expect(action?.arguments.assignee).toBe('dana');
      expect(action?.confidence).toBe('low');
    });

    it('never invents a placeholder key', () => {
      const rendered = JSON.stringify(analyzeTranscript('move it to done'));
      expect(rendered).not.toContain('SCRUM-?');
      expect(rendered).not.toContain('?-');
    });
  });

  it('collapses the same recommendation heard twice', () => {
    const actions = forTool('assign CHG-20 to dana. Again: assign CHG-20 to dana.', 'update_issue');
    expect(actions).toHaveLength(1);
  });

  it('orders the most confident recommendations first', () => {
    const actions = analyzeTranscript(
      'assign this to dana. assign CHG-20 to sam. move CHG-20 to in progress.'
    );
    const confidences = actions.map((action) => action.confidence);
    expect(confidences).toEqual([...confidences].sort());
    expect(confidences[0]).toBe('high');
  });

  it('reads a whole meeting', () => {
    const transcript = [
      'Dana: welcome everyone.',
      'Sam: we need to create a bug for the checkout 500s.',
      'Dana: assign CHG-20 to sam',
      'Sam: I will start work on CHG-20 today.',
      'Dana: also move CHG-19 to done, it shipped Friday.',
      'Dana: thanks all.',
    ].join('\n');

    const actions = analyzeTranscript(transcript, { projectKey: 'CHG' });
    expect(actions.map((action) => action.tool).sort()).toEqual([
      'create_issue',
      'transition_issue',
      'transition_issue',
      'update_issue',
    ]);
  });

  it('does not carry regex state between calls', () => {
    // The patterns are global; without a lastIndex reset the second call would
    // resume mid-string and miss the opening match.
    const first = forTool('assign CHG-20 to dana', 'update_issue');
    const second = forTool('assign CHG-20 to dana', 'update_issue');
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });
});

describe('formatActionsAsMarkdown', () => {
  it('explains what it looks for when nothing matched', () => {
    const markdown = formatActionsAsMarkdown([]);
    expect(markdown).toContain('No actionable items detected');
    expect(markdown).toContain('assign PROJ-12 to dana');
  });

  it('renders each action with its tool, arguments and source line', () => {
    const markdown = formatActionsAsMarkdown(analyzeTranscript('assign CHG-20 to dana.lin'));
    expect(markdown).toContain('## 1. Assign CHG-20 to dana.lin');
    expect(markdown).toContain('`update_issue`');
    expect(markdown).toContain('"assignee": "dana.lin"');
    expect(markdown).toContain('**Heard as:**');
  });

  it('states plainly that nothing was executed', () => {
    const markdown = formatActionsAsMarkdown(analyzeTranscript('move CHG-20 to done'));
    expect(markdown).toContain('Nothing above has been executed');
  });
});
