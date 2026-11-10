/**
 * A chat page's first paint stamps every preview card's recorded decision
 * onto its tool_result (chat-view.ts's withResolvedWidgets), so a card
 * opened on another device shows its receipt, not live buttons.
 */

import { withResolvedWidgets } from './chat-view';
import type { ChatBlock, WidgetDecisionState } from './views';

const SENT: WidgetDecisionState = { icon: 'sent', headline: 'Created OPS-99' };

const card = (previewId: string): ChatBlock => ({
  type: 'tool_result',
  toolUseId: `call-${previewId}`,
  content: 'Preview ready.',
  uiResourceUri: 'ui://renkei/issue-preview',
  structuredContent: { previewId },
});

describe('a chat’s cards on first paint', () => {
  it('carries a decided card’s receipt on its result', () => {
    const [stamped] = withResolvedWidgets([card('p-1')], new Map([['renkei-preview:p-1', SENT]]));
    expect(stamped).toMatchObject({ type: 'tool_result', resolved: SENT });
  });

  it('leaves an undecided card, plain text and results without a card as they are', () => {
    const blocks: ChatBlock[] = [
      card('p-2'),
      { type: 'text', text: 'Here it is.' },
      { type: 'tool_result', toolUseId: 'c1', content: 'ok' },
    ];
    const out = withResolvedWidgets(blocks, new Map([['renkei-preview:p-1', SENT]]));
    expect(out).toEqual(blocks);
  });

  it('hands back the same blocks when nothing has been decided', () => {
    const blocks = [card('p-1')];
    expect(withResolvedWidgets(blocks, new Map())).toBe(blocks);
  });
});
