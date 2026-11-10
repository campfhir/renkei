/**
 * The host half of a preview card's protocol (widget-card.model.ts): what
 * the chat does when the card in its frame says something. These were
 * the browser suite's (widget-card.spec.ts, widget-card-resolve.spec.ts);
 * the specs keep one real press through the frame and what only a
 * browser shows.
 */

import {
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  clampHeight,
  decisionOf,
  hostEffects,
  joinedText,
  resolvedKeyOf,
  toolCallReply,
  toolResultNotification,
  type HostContext,
  type ToolResultBlock,
} from './widget-card.model';

const PREVIEW = {
  kind: 'issue',
  previewId: 'p-1',
  title: 'Create Jira issue',
  confirmTool: 'jira_create_issue_confirm',
};

const RESULT: ToolResultBlock = {
  type: 'tool_result',
  toolUseId: 'toolu_1',
  content: 'Awaiting the user’s decision on the preview card.',
  structuredContent: PREVIEW,
};

const RECEIPT = { icon: 'sent' as const, headline: 'Created issue OPS-99.' };

const CONTEXT: HostContext = {
  theme: 'light',
  toolInput: { projectKey: 'OPS', summary: 'Rotate the Zoom webhook secret' },
  result: RESULT,
};

const rpc = (message: Record<string, unknown>) => ({ jsonrpc: '2.0', ...message });

describe('the handshake', () => {
  it('answers the card’s initialize with the page’s theme', () => {
    expect(hostEffects(rpc({ id: 1, method: 'ui/initialize' }), CONTEXT)).toEqual([
      { type: 'post', message: { id: 1, result: { hostContext: { theme: 'light' } } } },
    ]);
    expect(
      hostEffects(rpc({ id: 1, method: 'ui/initialize' }), { ...CONTEXT, theme: 'dark' })
    ).toEqual([{ type: 'post', message: { id: 1, result: { hostContext: { theme: 'dark' } } } }]);
  });

  it('once the card says it is ready, hands it the call’s input and then its result', () => {
    expect(hostEffects(rpc({ method: 'ui/notifications/initialized' }), CONTEXT)).toEqual([
      { type: 'initialized' },
      {
        type: 'post',
        message: {
          method: 'ui/notifications/tool-input',
          params: { arguments: CONTEXT.toolInput },
        },
      },
      {
        type: 'post',
        message: {
          method: 'ui/notifications/tool-result',
          params: {
            isError: false,
            content: [{ type: 'text', text: RESULT.content }],
            structuredContent: PREVIEW,
          },
        },
      },
    ]);
  });

  it('a call with no input hands the card empty arguments', () => {
    const effects = hostEffects(rpc({ method: 'ui/notifications/initialized' }), {
      ...CONTEXT,
      toolInput: undefined,
    });
    expect(effects[1]).toEqual({
      type: 'post',
      message: { method: 'ui/notifications/tool-input', params: { arguments: {} } },
    });
  });
});

describe('the result the card is handed', () => {
  it('a card already decided carries its receipt inside the preview, so it opens on the receipt', () => {
    expect(toolResultNotification({ ...RESULT, resolved: RECEIPT })).toEqual({
      method: 'ui/notifications/tool-result',
      params: {
        isError: false,
        content: [{ type: 'text', text: RESULT.content }],
        structuredContent: { ...PREVIEW, resolved: RECEIPT },
      },
    });
  });

  it('a failed tool is handed over as an error, with no empty text block', () => {
    const { structuredContent: _, ...plain } = RESULT;
    expect(toolResultNotification({ ...plain, content: '', isError: true })).toEqual({
      method: 'ui/notifications/tool-result',
      params: { isError: true, content: [] },
    });
  });

  it('a decision arriving later is told to the card only when the receipt itself changes', () => {
    expect(resolvedKeyOf(RESULT)).toBeNull();
    const decided = resolvedKeyOf({ ...RESULT, resolved: RECEIPT });
    expect(decided).not.toBeNull();
    // A re-render with the same receipt in a new object posts nothing new.
    expect(resolvedKeyOf({ ...RESULT, resolved: { ...RECEIPT } })).toBe(decided);
    expect(
      resolvedKeyOf({ ...RESULT, resolved: { ...RECEIPT, headline: 'Created by hand' } })
    ).not.toBe(decided);
  });
});

describe('the confirm button', () => {
  it('runs the named tool with the card’s arguments and its key, owed an answer by id', () => {
    const effects = hostEffects(
      rpc({
        id: 7,
        method: 'tools/call',
        params: {
          name: 'jira_create_issue_confirm',
          arguments: { projectKey: 'OPS', summary: 'Rotate it' },
          stateKey: 'renkei-preview:p-1',
        },
      }),
      CONTEXT
    );
    expect(effects).toEqual([
      {
        type: 'call-tool',
        id: 7,
        name: 'jira_create_issue_confirm',
        args: { projectKey: 'OPS', summary: 'Rotate it' },
        stateKey: 'renkei-preview:p-1',
      },
    ]);
  });

  it('a call with no key or arguments still runs, with nothing to check and nothing to pass', () => {
    expect(
      hostEffects(
        rpc({ id: 'a', method: 'tools/call', params: { name: 'x', arguments: [1] } }),
        CONTEXT
      )
    ).toEqual([{ type: 'call-tool', id: 'a', name: 'x', args: {}, stateKey: undefined }]);
  });

  it('hands the card the tool’s result', () => {
    const result = { content: [{ type: 'text', text: 'Created issue OPS-99.' }], isError: false };
    expect(toolCallReply(7, { data: { result }, error: null })).toEqual({ id: 7, result });
  });

  it('a card another device already decided gets the server’s refusal, word for word', () => {
    expect(
      toolCallReply(7, {
        data: null,
        error: 'This was already decided on another device — reload to see it.',
      })
    ).toEqual({
      id: 7,
      error: {
        code: -32000,
        message: 'This was already decided on another device — reload to see it.',
      },
    });
  });

  it('a server that gave no answer at all is “could not be reached”', () => {
    expect(toolCallReply(7, { data: null, error: null })).toEqual({
      id: 7,
      error: { code: -32000, message: 'The tool could not be reached.' },
    });
  });
});

describe('the decision', () => {
  const report = (state: unknown, stateKey: unknown = 'renkei-preview:p-1') =>
    hostEffects(rpc({ id: 3, method: 'ui/report-decision', params: { stateKey, state } }), CONTEXT);

  it('a receipt with the tick is recorded as confirmed', () => {
    expect(report(RECEIPT)).toEqual([
      { type: 'post', message: { id: 3, result: {} } },
      {
        type: 'report-decision',
        stateKey: 'renkei-preview:p-1',
        decision: 'confirmed',
        state: RECEIPT,
      },
    ]);
  });

  it('any other receipt is recorded as cancelled', () => {
    expect(decisionOf({ icon: 'cancelled', headline: 'Cancelled' })).toBe('cancelled');
    expect(decisionOf({ headline: 'Declined' })).toBe('cancelled');
    expect(report({ icon: 'cancelled', headline: 'Cancelled' })[1]).toMatchObject({
      decision: 'cancelled',
    });
  });

  it('a card with no key or no receipt is answered, and nothing is recorded', () => {
    expect(report(RECEIPT, '')).toEqual([{ type: 'post', message: { id: 3, result: {} } }]);
    expect(report(null)).toEqual([{ type: 'post', message: { id: 3, result: {} } }]);
  });
});

describe('what the person did, for the model', () => {
  it('the card’s text blocks become one note, carrying the card’s key', () => {
    expect(
      hostEffects(
        rpc({
          id: 4,
          method: 'ui/update-model-context',
          params: {
            content: [
              { type: 'text', text: 'The user confirmed "Create Jira issue" on the preview card.' },
              { type: 'image', data: '…' },
              { type: 'text', text: 'Result: Created issue OPS-99.' },
            ],
            stateKey: 'renkei-preview:p-1',
          },
        }),
        CONTEXT
      )
    ).toEqual([
      { type: 'post', message: { id: 4, result: {} } },
      {
        type: 'model-context',
        text: 'The user confirmed "Create Jira issue" on the preview card.\nResult: Created issue OPS-99.',
        stateKey: 'renkei-preview:p-1',
      },
    ]);
  });

  it('a card that said nothing is answered and writes no note', () => {
    expect(
      hostEffects(
        rpc({ id: 4, method: 'ui/update-model-context', params: { content: [] } }),
        CONTEXT
      )
    ).toEqual([{ type: 'post', message: { id: 4, result: {} } }]);
    expect(joinedText('not a list')).toBe('');
    expect(joinedText([null, 'x', { type: 'text', text: 5 }])).toBe('');
  });
});

describe('links', () => {
  it('a link the card asks for opens in a new tab', () => {
    expect(
      hostEffects(
        rpc({
          id: 5,
          method: 'ui/open-link',
          params: { url: 'https://example.atlassian.net/browse/OPS-99' },
        }),
        CONTEXT
      )
    ).toEqual([
      { type: 'post', message: { id: 5, result: {} } },
      { type: 'open-link', url: 'https://example.atlassian.net/browse/OPS-99' },
    ]);
  });

  it('an empty link is answered and opens nothing', () => {
    expect(hostEffects(rpc({ id: 5, method: 'ui/open-link', params: {} }), CONTEXT)).toEqual([
      { type: 'post', message: { id: 5, result: {} } },
    ]);
  });
});

describe('the frame’s height', () => {
  it('follows the card, rounded up, between a floor and a ceiling', () => {
    expect(DEFAULT_HEIGHT).toBe(96);
    expect(clampHeight(312.2)).toBe(313);
    expect(clampHeight(10)).toBe(MIN_HEIGHT);
    expect(clampHeight(50_000)).toBe(MAX_HEIGHT);
    expect(
      hostEffects(
        rpc({ method: 'ui/notifications/size-changed', params: { height: 200 } }),
        CONTEXT
      )
    ).toEqual([{ type: 'resize', height: 200 }]);
  });

  it('a size that is not a number leaves the frame as it is', () => {
    expect(clampHeight('200')).toBeNull();
    expect(clampHeight(Number.NaN)).toBeNull();
    expect(clampHeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(
      hostEffects(rpc({ method: 'ui/notifications/size-changed', params: {} }), CONTEXT)
    ).toEqual([]);
  });
});

describe('what the host ignores', () => {
  it('anything that is not JSON-RPC 2.0', () => {
    expect(hostEffects({ id: 1, method: 'ui/initialize' }, CONTEXT)).toEqual([]);
    expect(hostEffects('ui/initialize', CONTEXT)).toEqual([]);
    expect(hostEffects(null, CONTEXT)).toEqual([]);
  });

  it('a method it does not speak', () => {
    expect(hostEffects(rpc({ id: 1, method: 'ping' }), CONTEXT)).toEqual([]);
  });

  it('a request that owes an answer but carries no id', () => {
    for (const method of [
      'ui/initialize',
      'tools/call',
      'ui/report-decision',
      'ui/open-link',
      'ui/update-model-context',
    ]) {
      expect(
        hostEffects(
          rpc({ method, params: { name: 'x', url: 'https://x', stateKey: 'k', state: RECEIPT } }),
          CONTEXT
        )
      ).toEqual([]);
    }
  });
});
