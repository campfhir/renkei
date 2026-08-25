// Runs on: Calendar
//
// Removes the Teams/Zoom/Webex join block from an invite while keeping the
// coordinates someone needs in order to actually join.
//
// This is the highest-value script in the library. The block is six useful
// tokens — meeting id, passcode, dial-in — wrapped in forty lines of
// instructions that are byte-identical across every meeting in the
// organization. Left in, that boilerplate dominates the vector and every
// invite retrieves every other invite.
//
// Line-oriented rather than block-oriented because the providers disagree
// about where their block starts and none of them mark where it ends: a
// start-to-end matcher either stops early and leaves half the chrome, or
// runs long and eats the agenda underneath it.
//
// Every rule fails toward KEEPING. A line carrying a link, a long digit
// run, or a named credential with an actual value is never dropped, however
// chrome-like it reads — losing a join URL is far worse than leaving a
// stray line of instructions.
(email) => {
  const chrome = [
    // Teams
    /^microsoft teams$/i,
    /^need help\??$/i,
    /^join the meeting now$/i,
    /^join on your computer,?.*$/i,
    /^click here to join the meeting$/i,
    /^download teams\b.*$/i,
    /^join on the web( instead)?$/i,
    /^dial in by phone$/i,
    /^find a local number.*$/i,
    /^reset dial-?in pin.*$/i,
    /^for organi[sz]ers:?.*$/i,
    /^meeting options\b.*$/i,
    /^or call in \(audio only\)$/i,
    /^learn more\b.*$/i,
    // Zoom
    /^one tap mobile$/i,
    /^dial by your location$/i,
    /^find your local number:?$/i,
    /^join zoom meeting$/i,
    // Webex
    /^join meeting$/i,
    /^more ways to join:?$/i,
    /^join from the meeting link$/i,
    /^join by meeting number$/i,
    /^tap to join from a mobile device.*$/i,
    /^join by phone$/i,
    /^global call-?in numbers.*$/i,
    /^join from a video system or application$/i,
    /^need help\? go to\b.*$/i,
    // The rules the providers draw around the block.
    /^[_\-=*~]{6,}$/,
  ];

  const loadBearing = [
    /https?:\/\//i,
    // Any run of digits long enough to be an id, a PIN or a phone number,
    // including the spaced groups Teams prints.
    /\d(?:[\s-]?\d){4,}/,
    // The word plus an actual value. Bare "Reset dial-in PIN" is an
    // instruction, not a credential — matching the noun alone would keep
    // every line of chrome that happens to name one.
    /\b(?:passcode|password|pin|meeting id|access code|conference id)\b\s*[:#-]?\s*[A-Za-z0-9]{4,}/i,
  ];

  const kept = [];
  const lines = email.text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line) {
      let isChrome = false;
      for (const pattern of chrome) {
        if (pattern.test(line)) {
          isChrome = true;
          break;
        }
      }
      if (isChrome) {
        let keep = false;
        for (const pattern of loadBearing) {
          if (pattern.test(line)) {
            keep = true;
            break;
          }
        }
        if (!keep) continue;
      }
    }
    kept.push(raw);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
