# Quick Chat Window Zoom

This private opt-in feature makes the popped-out Quick Chat window consume the
same app zoom level as the main window. It replaces Quick Chat's fixed
`h-dvh w-full` root with the existing `zoomedViewport` style contract and marks
the popped-out window as zoomed for Quick Chat's internal scroll-coordinate
conversion. Without the second half, submitting a prompt at non-default zoom
can anchor the new turn far past its intended position and leave most of the
window blank. The detached window also caps Quick Chat's synthetic thread-tail
spacer at 48 CSS pixels: enough room for response controls above the fixed
composer without pushing earlier turns above a mostly empty viewport. The
floating overlay keeps upstream's reserved response space.

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

The patch is idempotent and all-or-nothing across discovered Quick Chat roots,
their zoom-aware scroll signals, and the detached-window thread-tail spacer. If
an upstream bundle drifts or any contract cannot be verified, it warns and
leaves the asset unchanged. Since enabled-feature drift rejects an updater
candidate, upstream app updates must pass CI before this feature is deployed.
