/**
 * The wire summary's one hard promise: structure stays, content goes.
 * Field names, the token-limit key, roles and ordering must survive;
 * anything a person wrote must not.
 */

import { summarizeWireRequest } from './wire-summary';

describe('summarizeWireRequest', () => {
  it('keeps structural fields and replaces content with lengths', () => {
    const secret = 'the user wrote something private about PROJ-42 and a colleague';
    const summary = summarizeWireRequest('https://x.example/chat/completions', {
      model: 'gpt-5.4',
      max_completion_tokens: 4096,
      reasoning_effort: 'high',
      system: secret,
      messages: [
        { role: 'system', content: secret },
        { role: 'user', content: [{ type: 'text', text: secret }] },
      ],
      tools: [{ name: 'a' }, { name: 'b' }],
      tool_choice: 'auto',
    });

    // Everything that diagnoses a wrong payload is present…
    expect(summary).toContain('max_completion_tokens');
    expect(summary).toContain('4096');
    expect(summary).toContain('reasoning_effort');
    expect(summary).toContain('"role": "user"');
    expect(summary).toContain('<2 tool defs>');
    expect(summary).toContain('POST https://x.example/chat/completions');
    // …and nothing anyone wrote is.
    expect(summary).not.toContain('PROJ-42');
    expect(summary).toContain(`<${secret.length} chars>`);
  });

  it('redacts the Responses dialect (instructions/input) the same way', () => {
    const secret = 'the user wrote something private about PROJ-42 and a colleague';
    const toolArgs = '{"query":"a fairly long argument string that a model wrote"}';
    const summary = summarizeWireRequest('https://x.example/responses', {
      model: 'gpt-6-astra-1',
      max_output_tokens: 512,
      reasoning: { effort: 'medium' },
      instructions: secret,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: secret }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: toolArgs },
        { type: 'function_call_output', call_id: 'call_1', output: secret },
      ],
      tools: [{ type: 'function', name: 'get_weather' }],
      tool_choice: 'auto',
    });

    expect(summary).toContain('max_output_tokens');
    expect(summary).toContain('reasoning');
    expect(summary).toContain('"role": "user"');
    expect(summary).toContain('"type": "function_call"');
    expect(summary).toContain('"call_id": "call_1"');
    expect(summary).toContain('"name": "get_weather"');
    expect(summary).toContain('<1 tool defs>');
    expect(summary).not.toContain('PROJ-42');
    expect(summary).not.toContain(toolArgs);
    expect(summary).toContain(`<${secret.length} chars>`);
    expect(summary).toContain(`<${toolArgs.length} chars>`);
  });
});
