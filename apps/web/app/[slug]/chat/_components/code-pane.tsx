'use client';

/**
 * A tool call's input or result as a coloured pane. The input is JSON by
 * construction, and it is coloured as such even while it streams in; a
 * result is coloured only when it parses as JSON (most tools answer with
 * it) and left plain otherwise — see guessPaneLanguage. The tokens come
 * from components/code-tokens.tsx, so the pane shares the chat's code
 * palette.
 */

import { useMemo } from 'react';
import { highlightedTokens } from '@/components/code-tokens';
import { guessPaneLanguage } from '@/lib/chat/code-languages';

export default function CodePane({
  text,
  language,
  className = 'chat-pre',
}: {
  text: string;
  /** Known up front (a tool's JSON input), or guessed from the text when omitted. */
  language?: string;
  className?: string;
}) {
  const tokens = useMemo(
    () => highlightedTokens(text, language ?? guessPaneLanguage(text)),
    [text, language]
  );
  return <pre className={className}>{tokens}</pre>;
}
