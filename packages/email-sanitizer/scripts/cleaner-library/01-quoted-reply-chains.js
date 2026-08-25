// Runs on: Email
//
// Truncates the quoted reply chain, and with it every old signature and
// footer nested inside — which is why this is worth installing FIRST.
//
// Each divider is anchored to a real client's literal format rather than a
// guess at where "the old stuff" starts. The earliest match in the message
// wins, so a thread quoting a thread is cut at the outermost boundary.
(email) => {
  const dividers = [
    // Outlook desktop's plain-text divider.
    /^-{3,}\s*Original Message\s*-{3,}$/im,
    // Outlook's header block for a forwarded or replied message.
    /^From:.*\r?\nSent:.*\r?\nTo:.*\r?\nSubject:.*$/im,
    // Gmail, Apple Mail, and most webmail attribution lines. Bounded at 120
    // characters so it cannot run away across a paragraph.
    /^On .{0,120} wrote:\s*$/im,
  ];

  let cut = email.text.length;
  for (const divider of dividers) {
    const match = divider.exec(email.text);
    if (match && match.index < cut) cut = match.index;
  }
  return email.text.slice(0, cut).trimEnd();
}
