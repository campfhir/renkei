# Code editor sketches

The artboards behind [`docs/code-editor-design.md`](../../code-editor-design.md),
kept here so they outlive the session that drew them. The live canvas is
<https://claude.ai/artifact/BHHzFmmvUBMJTK94LQhLYM>; these are its files as
published, one `.dc.html` per artboard and `canvas.json` for their layout and
the notes beside them.

Each artboard is plain HTML with inline styles: open one in a browser and it
renders as drawn (the `<x-dc>` wrapper and the `text/x-dc` script are the
canvas's own and are ignored elsewhere).

| File                      | Shows                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| `Desktop-Split.dc.html`   | The split, code 70 / chat 30, inside the whole app shell                     |
| `Desktop-Editing.dc.html` | Unsaved edits, lines changed against HEAD, a file the chat's turn also wrote |
| `Desktop-Commit.dc.html`  | The Commit dialog, and what it becomes after the commit                      |
| `Phone-Chat.dc.html`      | The Chat tab, with the Chat / Code switch in the title bar                   |
| `Phone-Files.dc.html`     | The Code tab: changed files first, then the tree, Commit in the bottom bar   |
| `Phone-Code.dc.html`      | Editing on a phone: text area, accessory keys, Save above the keyboard       |
| `Phone-Commit.dc.html`    | Commit as a bottom sheet                                                     |
