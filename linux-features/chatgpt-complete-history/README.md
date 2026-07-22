# ChatGPT Complete History

This opt-in feature fills the conversation-history gaps in desktop ChatGPT:

- Quick Chat history includes conversations whose `conversation_origin` is
  `tpp`, including chats created in the phone app. Current upstream builds
  already fetch normal and TPP conversations separately and merge them for the
  full history; the feature verifies that native contract before changing Quick
  Chat.

The feature preserves archived-chat handling and generic history pagination. It
reuses the app's authenticated TPP query instead of adding a separate credential
or network client.

It does not alter the main **Projects** or **Scheduled** pages. Those pages keep
their upstream Codex-local behavior; ChatGPT cloud projects and schedule
definitions remain available through ChatGPT's native cloud surfaces.

This is disabled by default because upstream still excludes TPP conversations
from Quick Chat history.

## Enable

Add `chatgpt-complete-history` to `linux-features/features.json`, or pass the id
through the Nix `linuxFeatureIds` option.

## Test

Run:

```bash
node --test linux-features/chatgpt-complete-history/test.js
node --test scripts/patch-linux-window-ui.test.js
```

The patch discovers both contracts by content instead of hashed bundle names.
It is idempotent and all-or-nothing: if the Quick Chat filter or upstream's
native full-history merge drifts or becomes ambiguous, every asset remains
byte-identical. Enabled-feature drift then rejects the candidate before it can
replace the working app.
