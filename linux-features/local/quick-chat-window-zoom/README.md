# Quick Chat Window Zoom

This private opt-in feature makes the popped-out Quick Chat window consume the
same app zoom level as the main window. It replaces Quick Chat's fixed
`h-dvh w-full` root with the existing `zoomedViewport` style contract.

The feature is intentionally local rather than part of the upstream core patch
set: it is a workflow-specific customization and upstream does not consider it
required Linux compatibility behavior.

## Enable

Add `quick-chat-window-zoom` to `linux-features/features.json`, or pass the id
through the Nix `linuxFeatureIds` option. This checkout force-tracks the
otherwise ignored local feature so the pinned CI builder and update-builder can
reproduce it. The private fork also allowlists this id in
`nix/linux-features.nix`, because the upstream Nix interface intentionally
rejects feature ids it does not know.

## Test

Run:

```bash
node --test linux-features/local/quick-chat-window-zoom/test.js
node --test scripts/patch-linux-window-ui.test.js
```

The patch is idempotent and all-or-nothing across discovered Quick Chat roots.
If an upstream bundle drifts or its style contract cannot be verified, it warns
and leaves the asset unchanged. Since enabled-feature drift rejects an updater
candidate, upstream app updates must pass CI before this feature is deployed.
