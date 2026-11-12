# session-memo

A plain notepad pane beside the chat in Claude Code. It is just for you: nothing you write is sent to Claude, and writing in it uses no tokens.

## Features

- **One memo shared by every session.** Open it in any Claude window and you see the same text. A change made in one window shows up in the others within about a second.
- **📝 button above the prompt.** Click it to open the memo; click it again to close it. `/memo` opens it too.
- **Quick notes from the chat.** A message that starts with `ㅁ`, `메모:` or `memo:` goes into the memo instead of to Claude. Screenshots pasted with it are kept under the text.
- **New lines with Shift+Enter.** Shift+Enter breaks the line at the cursor. Plain Enter only saves.

## Install

At the prompt of a terminal session:

```
/plugin install session-memo --marketplace trubotshow/session-memo
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install session-memo --marketplace trubotshow/session-memo
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `trubotshow/session-memo`, then Add plugin.

## To do

- Attach a screenshot to each line of the memo. A way to do this has not been found yet.
