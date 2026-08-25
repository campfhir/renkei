// Runs on: Email
//
// Cuts everything after the RFC 3676 §4.3 signature delimiter: a line that
// is exactly "--" or "-- ".
//
// Deliberately the strict delimiter and nothing else. Every looser rule for
// "this looks like a signature" — a line of dashes, a name followed by a
// title, a phone number — eventually eats a real sentence, and truncating
// correspondence is far worse than indexing a job title.
(email) => {
  const match = /^-- ?$/m.exec(email.text);
  return match ? email.text.slice(0, match.index).trimEnd() : email.text;
};
