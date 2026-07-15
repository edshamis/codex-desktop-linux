# ChatGPT Complete History

This opt-in feature fills the conversation-history gaps in desktop ChatGPT:

- Quick Chat history includes conversations whose `conversation_origin` is
  `tpp`, including chats created in the phone app. Full history merges the
  dedicated TPP feed and deduplicates it against generic history.

The feature preserves archived-chat handling and generic history pagination. It
reuses the app's authenticated TPP query instead of adding a separate credential
or network client.

It does not alter the main **Projects** or **Scheduled** pages. Those pages keep
their upstream Codex-local behavior; ChatGPT cloud projects and schedule
definitions remain available through ChatGPT's native cloud surfaces.

This is disabled by default because upstream currently excludes TPP
conversations from these history surfaces.

## Enable

Add `chatgpt-complete-history` to `linux-features/features.json`, or pass the id
through the Nix `linuxFeatureIds` option.

## Test

Run:

```bash
node --test linux-features/chatgpt-complete-history/test.js
node --test scripts/patch-linux-window-ui.test.js
```

The shared-history patch is idempotent and all-or-nothing for its target asset.
If a required upstream contract drifts, that asset remains byte-identical.
Enabled-feature drift then rejects the candidate before it can replace the
working app.
