// Runs on: Email
//
// Drops everything from the first line of a confidentiality or legal
// footer to the end of the message.
//
// The anchor list is short and literal on purpose. These phrases appear
// only inside such footers, so a match is near-certain; broad keyword
// scoring ("confidential", "intended recipient") would eventually fire on
// a real sentence and truncate the message that contains it.
(email) => {
  const anchors = [
    'this message and any attachments',
    'this e-mail and any attachments',
    'this email and any attachments',
    'confidentiality notice',
    'this e-mail may contain confidential',
    'this email may contain confidential',
    'this message may contain confidential',
    'is intended only for the use of the individual',
    'if you are not the intended recipient',
    'please consider the environment before printing',
  ];

  const lines = email.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    for (const anchor of anchors) {
      if (lower.indexOf(anchor) !== -1) return lines.slice(0, i).join('\n').trimEnd();
    }
  }
  return email.text;
};
