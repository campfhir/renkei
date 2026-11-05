/**
 * Refining a project's instructions: what the model is sent and how its
 * reply becomes a proposal. The route that asks for one is tested beside
 * it (app/api/chat/projects/[projectId]/instructions/refine/route.test.ts).
 */

import { buildRefinePrompt, parseRefineReply, REFINE_TOOL } from './refine-instructions';

describe('the prompt', () => {
  it('names the project and carries the draft and what the editor asked for', () => {
    const prompt = buildRefinePrompt({
      kind: 'chat',
      name: 'Hiring',
      description: 'Interview loops',
      instructions: 'help w/ interviews. be nice',
      guidance: '  make it shorter  ',
    });
    expect(prompt).toContain('Project: Hiring');
    expect(prompt).toContain('Description: Interview loops');
    expect(prompt).toContain('<draft>\nhelp w/ interviews. be nice\n</draft>');
    expect(prompt).toContain('What the editor wants changed:\nmake it shorter');
  });

  it('says nothing about changes the editor did not ask for, and names a code project', () => {
    const prompt = buildRefinePrompt({
      kind: 'code',
      name: 'API',
      description: null,
      instructions: 'x',
      guidance: '   ',
    });
    expect(prompt).toContain('a code project');
    expect(prompt).not.toContain('Description:');
    expect(prompt).not.toContain('wants changed');
  });
});

describe('the reply', () => {
  it('is the tool’s rewrite, trimmed', () => {
    expect(
      parseRefineReply([
        {
          type: 'tool_use',
          name: REFINE_TOOL,
          input: {
            instructions: '  # Hiring\n\nYou help.  ',
          },
        },
      ])
    ).toEqual({ instructions: '# Hiring\n\nYou help.' });
  });

  it('is the text when the model answered without the tool', () => {
    expect(parseRefineReply([{ type: 'text', text: ' You help with hiring. ' }])).toEqual({
      instructions: 'You help with hiring.',
    });
  });

  it('is nothing when the tool came back empty, or nothing came back', () => {
    expect(
      parseRefineReply([{ type: 'tool_use', name: REFINE_TOOL, input: { instructions: ' ' } }])
    ).toBeNull();
    expect(parseRefineReply([])).toBeNull();
  });
});
