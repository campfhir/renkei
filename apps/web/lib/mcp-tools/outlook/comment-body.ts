/**
 * Puts the caller's Markdown comment atop a reply/reply-all/forward draft.
 *
 * Graph's `createReply` / `createForward` accept a `comment`, but they drop
 * it into the draft's body verbatim — and that body is HTML whenever the
 * original message was, which is nearly always. Whitespace collapses in
 * HTML, so "Hi,\n\n1. First\n2. Second" arrived as one run-on line, and the
 * bodyPreview Graph derives from it was just as flat. So the draft is
 * created with NO comment and the text is prepended here in the draft's
 * own content type: rendered from Markdown for an HTML thread, as written
 * for a plain-text one (where Markdown reads fine as text anyway). The
 * quoted thread Graph built stays below, untouched.
 */

import { markdownToHtml } from './markdown';

export interface MessageBody {
  contentType: 'HTML' | 'Text';
  content: string;
}

/**
 * The body to PATCH onto the draft: `comment` first, then whatever Graph
 * already put there (the quoted thread). Inserted inside `<body>` when the
 * HTML has one so the comment renders rather than landing before `<html>`.
 */
export function prependComment(
  body: { contentType?: unknown; content?: unknown },
  comment: string
): MessageBody {
  const existing = typeof body.content === 'string' ? body.content : '';
  const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : '';

  if (contentType === 'text') {
    return {
      contentType: 'Text',
      content: existing ? `${comment}\n\n${existing}` : comment,
    };
  }

  const html = markdownToHtml(comment) + '<br>';
  const bodyOpen = /<body[^>]*>/i.exec(existing);
  if (!bodyOpen) return { contentType: 'HTML', content: html + existing };
  const at = bodyOpen.index + bodyOpen[0].length;
  return { contentType: 'HTML', content: existing.slice(0, at) + html + existing.slice(at) };
}
