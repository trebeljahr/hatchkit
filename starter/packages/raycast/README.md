# Starter Launcher

Capture an item without leaving the keyboard, and see what you touched last
without opening a browser.

The extension keeps working when the server does not answer. Your change is
saved on this machine and sent in order once the server is back.

## Commands

| Command      | What it does                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Current Item | A menu bar entry showing the item you touched last, and how many changes are still unsent.                    |
| Capture Item | Creates an item from the text you type after the command, or from your clipboard. Bind a global hotkey to it. |
| New Item     | A form for a title and a description.                                                                         |
| Search Items | Your items, including the ones still waiting to be sent.                                                      |
| Open Web App | Opens the web app, after sending anything that is queued.                                                     |

Five commands. Everything else stays in the web app, one keystroke away.

## Signing in

You pair the extension with your account. Run any command, choose **Pair with
the Web App**, and approve the short code in your browser. No password is typed
into the launcher.

The credential is held in the launcher's own encrypted store, and it belongs to
the server that issued it. Point the extension at a different server and it
reports you as signed out there, rather than sending the old credential on.

## Preferences

Both are optional. Leave them empty to use the service this build was made for.

- **API Origin** — where the API lives.
- **Web App Origin** — where the web app lives.

## Offline

Changes you make with no answer from the server are kept on this machine and
sent later, in the order you made them. They survive a restart.

Queued work is sent when a command reads or writes, because a launcher has no
process running in the background. Opening the web app sends it too.

Unsent items appear in **Search Items** marked `unsent`.

## Limitations

- Deleting and editing items needs a server that reports the matching
  capability. Against an older server those actions are not offered.
- The extension shows and edits items. Everything else is web app work.
- One language: English.
