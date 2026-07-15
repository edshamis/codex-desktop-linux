# ChatGPT Complete History

This opt-in feature fills the history gaps in the desktop ChatGPT surfaces:

- Quick Chat history includes conversations whose `conversation_origin` is
  `tpp`, including chats created in the phone app. Full history merges the
  dedicated TPP feed and deduplicates it against generic history.
- The main **Projects** page combines local Codex projects with every project
  returned by the existing ChatGPT cloud project query. Cloud rows are visibly
  labelled and open the corresponding project on ChatGPT; they are never sent
  through local project edit, pin, or launch handlers.
- The main **Scheduled** page includes a separate **ChatGPT cloud** section for
  scheduled-run conversations from the existing TPP feed. A run opens in the
  desktop conversation route, while **Manage in ChatGPT** opens the cloud task
  manager for creating, editing, pausing, or deleting definitions.

The feature preserves archived-chat handling, generic history pagination, and
local Codex project and automation behavior. It reuses the app's authenticated
ChatGPT project and TPP queries instead of adding a separate credential or
network client.

ChatGPT cloud scheduled-task definitions do not use the local Codex automation
schema. The Scheduled integration is therefore intentionally read-only inside
the desktop app: it shows known cloud runs and delegates definition management
to ChatGPT. A cloud task that has never produced a synced conversation may not
appear in the run list yet.

This is disabled by default because upstream currently keeps ChatGPT cloud
projects and scheduled tasks separate from the Codex-local main pages.

## Enable

Add `chatgpt-complete-history` to `linux-features/features.json`, or pass the id
through the Nix `linuxFeatureIds` option.

## Test

Run:

```bash
node --test linux-features/chatgpt-complete-history/test.js
node --test scripts/patch-linux-window-ui.test.js
```

Each of the shared-history, Projects, and Scheduled patches is idempotent and
all-or-nothing for its target asset. If a required upstream contract drifts,
that asset remains byte-identical. Enabled-feature drift then rejects the
candidate before it can replace the working app.
