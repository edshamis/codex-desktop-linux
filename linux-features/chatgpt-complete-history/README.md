# ChatGPT Complete History

This opt-in feature fills the history gaps in the desktop ChatGPT surfaces:

- Quick Chat history includes conversations whose `conversation_origin` is
  `tpp`, including chats created in the phone app. Full history also merges the
  dedicated TPP feed so conversations produced by scheduled runs appear under
  a **Scheduled** heading.
- Full Quick Chat history groups project conversations under their ChatGPT
  project names, such as **life**, and keeps projectless conversations under
  **Recent chats**. It seeds headings from the complete project-name map, so a
  project remains visible even when none of its chats are in the loaded history
  page. Opening full history resets its shared scroll container to the first
  section, so Scheduled and project headings are not hidden above the viewport.
  Project-name query updates also invalidate the compiled history projection,
  preventing headings from remaining stale. The compact recent-chat preview
  remains ungrouped.
- The ChatGPT project list stays fully expanded instead of initially exposing
  only five projects behind a **Show all projects** control.

The feature preserves archived-chat handling, generic history pagination, and
the dedicated TPP/Codex Tasks lane. It adds one existing TPP conversation query
to full Quick Chat history and deduplicates its results against the generic
feed. Schedule definitions still live in Automations; this feature exposes
their resulting conversations in Quick Chat history.

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

The patch is idempotent and all-or-nothing. If any TPP filter, dedicated-feed,
history-row, history-scroll, section-renderer, project-memo, or project-collapse
contract drifts in a future upstream bundle, the feature warns and leaves that
asset byte-identical.
Enabled-feature drift then rejects the candidate before it can replace the
working app.
