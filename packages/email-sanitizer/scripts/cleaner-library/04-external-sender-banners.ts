// Runs on: Email
//
// Strips the warning banner a mail gateway staples to the top of outside
// mail. It is not written by the sender, so it is noise in the embedding —
// and because every external message carries the SAME banner, leaving it in
// makes them all look alike to a vector search.
//
// These two phrasings shipped as built-in defaults before cleaning moved
// into scripts. If your organization also had its own phrases configured,
// they were migrated into a separate generated script named
// "External-sender banners" — check for it before installing this, and
// merge the lists rather than running both.
//
// Matching is word-by-word with \s+ between words, so a mail client that
// re-wraps the banner across lines cannot dodge it.
function stripBanners(email: CleanerEmail): string {
  const phrases = [
    'CAUTION : This Email is from an EXTERNAL source. DO NOT CLICK LINKS or ' +
      'ATTACHMENTS if the email is not anticipated, and NEVER provide your User ID or Password.',
    '[EXTERNAL EMAIL] DO NOT CLICK links or attachments unless you recognize the sender ' +
      'and know the content is safe.',
  ];

  let text = email.text;
  for (const phrase of phrases) {
    const words = phrase
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (words.length === 0) continue;
    text = text.replace(new RegExp(words.join('\\s+'), 'gi'), '');
  }
  return text.trim();
}
