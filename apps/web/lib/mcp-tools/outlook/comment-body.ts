/**
 * Puts the caller's plain-text comment atop a reply/reply-all/forward draft.
 *
 * Graph's `createReply` / `createForward` accept a `comment`, but they drop
 * it into the draft's body verbatim — and that body is HTML whenever the
 * original message was, which is nearly always. Whitespace collapses in
 * HTML, so "Hi,\n\n1. First\n2. Second" arrives as one run-on line, and the
 * bodyPreview Graph derives from it is just as flat. The fix is to create
 * the draft with NO comment and prepend the text ourselves in the draft's
 * own content type: escaped with `<br>` line breaks for HTML, as-is for a
 * plain-text draft. The quoted thread Graph built stays below, untouched.
 */

export interface MessageBody {
  contentType: 'HTML' | 'Text';
  content: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text → an HTML block that renders the same line structure. */
export function commentToHtml(comment: string): string {
  const lines = comment.replace(/\r\n?/g, '\n').split('\n').map(escapeHtml);
  return `<div>${lines.join('<br>')}</div><br>`;
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

  const html = commentToHtml(comment);
  const bodyOpen = /<body[^>]*>/i.exec(existing);
  if (!bodyOpen) return { contentType: 'HTML', content: html + existing };
  const at = bodyOpen.index + bodyOpen[0].length;
  return { contentType: 'HTML', content: existing.slice(0, at) + html + existing.slice(at) };
}
