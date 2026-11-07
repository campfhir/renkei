/**
 * What the chat's menu offers for the project's previews: an item per
 * preview that is up, named when there are several, nothing for one that
 * exited or when nothing runs; and the server's answer read into entries,
 * with anything malformed left out.
 */
import {
  codeChatPreviewsReducer,
  initialCodeChatPreviews,
  previewEntriesOf,
  previewMenuItems,
} from './code-chat-previews.model';

const web = {
  name: 'web',
  status: 'running' as const,
  url: 'https://r.example/api/code/projects/p/chats/c/previews/web/app/',
  publicUrl: null,
};
const api = {
  ...web,
  name: 'api',
  url: 'https://r.example/api/code/projects/p/chats/c/previews/api/app/',
};

describe('the Open preview items', () => {
  it('offers nothing while nothing runs', () => {
    expect(previewMenuItems(initialCodeChatPreviews)).toEqual([]);
  });

  it('offers one plain item for a single running preview', () => {
    const state = codeChatPreviewsReducer(initialCodeChatPreviews, {
      type: 'loaded',
      previews: [web],
    });
    expect(previewMenuItems(state)).toEqual([{ label: 'Open preview', url: web.url }]);
  });

  it('names each when several are up, and leaves out one that exited', () => {
    const state = codeChatPreviewsReducer(initialCodeChatPreviews, {
      type: 'loaded',
      previews: [web, api, { ...web, name: 'old', status: 'exited' }],
    });
    expect(previewMenuItems(state)).toEqual([
      { label: 'Open preview: web', url: web.url },
      { label: 'Open preview: api', url: api.url },
    ]);
  });

  it('a starting preview is offered too (its page says it is coming up)', () => {
    const state = codeChatPreviewsReducer(initialCodeChatPreviews, {
      type: 'loaded',
      previews: [{ ...web, status: 'starting' }],
    });
    expect(previewMenuItems(state)).toHaveLength(1);
  });

  it('clears when the chat leaves its project', () => {
    const loaded = codeChatPreviewsReducer(initialCodeChatPreviews, {
      type: 'loaded',
      previews: [web],
    });
    expect(codeChatPreviewsReducer(loaded, { type: 'cleared' })).toEqual({ previews: [] });
    expect(codeChatPreviewsReducer(initialCodeChatPreviews, { type: 'cleared' })).toBe(
      initialCodeChatPreviews
    );
  });
});

describe('reading the server’s answer', () => {
  it('keeps the entries in shape and drops the rest', () => {
    expect(
      previewEntriesOf({
        previews: [
          {
            name: 'web',
            status: 'running',
            url: web.url,
            publicUrl: 'https://r.example/api/code/preview/t/',
          },
          { name: 'odd', status: 'weird', url: api.url },
          { status: 'running', url: api.url },
          'nope',
        ],
      })
    ).toEqual([
      { ...web, publicUrl: 'https://r.example/api/code/preview/t/' },
      { name: 'odd', status: 'exited', url: api.url, publicUrl: null },
    ]);
    expect(previewEntriesOf(null)).toEqual([]);
    expect(previewEntriesOf({ previews: 'x' })).toEqual([]);
  });
});
