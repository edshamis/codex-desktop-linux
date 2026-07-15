# ChatGPT Complete History

This opt-in feature removes two upstream presentation boundaries from the
desktop ChatGPT surfaces:

- Quick Chat history includes conversations whose `conversation_origin` is
  `tpp`, including chats created in the phone app and conversations produced by
  scheduled runs.
- The ChatGPT project list stays fully expanded instead of initially exposing
  only five projects behind a **Show all projects** control.

The feature does not change the conversation or project API requests. It uses
the data already returned by ChatGPT, preserves archived-chat handling and
pagination, and leaves the dedicated TPP/Codex Tasks lane intact. Schedule
definitions still live in Automations; this feature exposes their resulting
conversations in Quick Chat history.

This is disabled by default because upstream intentionally separates TPP tasks
from classic Quick Chat history and collapses long project lists. Enabling it
may therefore show the same TPP conversation in both Quick Chat history and the
main Tasks lane.

## Enable

Add `chatgpt-complete-history` to `linux-features/features.json`, or pass the id
through the Nix `linuxFeatureIds` option.

## Test

Run:

```bash
node --test linux-features/chatgpt-complete-history/test.js
node --test scripts/patch-linux-window-ui.test.js
```

The patch is idempotent and all-or-nothing. If any of the two TPP filters or the
project-collapse contract drifts in a future upstream bundle, the feature warns
and leaves that asset byte-identical. Enabled-feature drift then rejects the
candidate before it can replace the working app.
