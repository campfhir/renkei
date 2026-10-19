import { untrustedBlock } from '@renkei/agents';
import { toolResultText } from './tool-result';

const whole = `${'AIG field row. '.repeat(400)}AIG.14 Filler Status Code`;
const preview = `${whole.slice(0, 2000)}… [truncated]`;

describe('toolResultText', () => {
  it('shows the whole stored result, unfenced, for a call with its toolUseId', () => {
    const detail = {
      results: [
        {
          type: 'tool_result',
          toolUseId: 'tu_1',
          content: untrustedBlock('tool:sandbox_browser_navigate', whole),
        },
      ],
    };
    expect(toolResultText(detail, { resultPreview: preview, toolUseId: 'tu_1' })).toBe(whole);
  });

  it('reads a result whose content is text blocks', () => {
    const detail = {
      results: [{ toolUseId: 'tu_1', content: [{ type: 'text', text: whole }] }],
    };
    expect(toolResultText(detail, { resultPreview: preview, toolUseId: 'tu_1' })).toBe(whole);
  });

  it('falls back to the preview without an id, a match, or a longer result', () => {
    const detail = { results: [{ toolUseId: 'tu_1', content: 'short' }] };
    expect(toolResultText(detail, { resultPreview: preview })).toBe(preview);
    expect(toolResultText(detail, { resultPreview: preview, toolUseId: 'tu_2' })).toBe(preview);
    expect(toolResultText(detail, { resultPreview: preview, toolUseId: 'tu_1' })).toBe(preview);
    expect(toolResultText({}, {})).toBeNull();
  });
});
