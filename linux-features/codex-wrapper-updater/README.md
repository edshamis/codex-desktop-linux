# codex-wrapper-updater

Adds a **separate** in-app Update button for the *wrapper* — this project's own
Linux features, patches, and fixes (the `codex-desktop-linux` repository) — as
opposed to the upstream Codex app (DMG) updater, which has its own button.

## What it does

- A small top-right **Update** button appears only when `codex-update-manager`
  reports that a newer upstream wrapper build is available (it stays invisible
  otherwise, like the DMG update button).
- The button's tooltip shows the changelog of what changed.
- One click writes a `wrapper-update-pending` marker and quits the app. On the
  next launch, the launcher consumes the marker and runs
  `codex-update-manager apply-wrapper-update`, which:
  - **user-local installs**: re-runs `install.sh` in place via
    `~/.local/bin/codex-desktop-update` (no privilege escalation), then relaunches;
  - **packaged installs**: rebuilds a native package from a freshly fetched
    wrapper source and installs it with `pkexec`. If the build toolchain
    (`cargo`, a DMG extractor) is missing, it shows a notification instead.

## Enabling

This feature is opt-in twice, by design:

1. Enable the feature for the build by adding `codex-wrapper-updater` to
   `linux-features/features.json`.
2. Turn on **Settings → Keybinds → Updates → "Check for Codex Desktop Linux
   updates"** (persists `codex-linux-wrapper-updates-enabled` in
   `settings.json`). Until this is on, `codex-update-manager` does not track the
   wrapper axis and the button never appears.

## How to test

- Enable both opt-ins above and rebuild/install.
- With an older installed build, `codex-update-manager check-wrapper --json`
  reports `candidate_wrapper_commit` + `wrapper_changelog`.
- Open Codex: the Update button appears top-right; click it; the app exits and
  relaunches into the rebuilt wrapper. The button then disappears.

## Known risks

- Packaged rebuild is heavy (clone + `install.sh` + package build + `pkexec`);
  it degrades to a notification when build tools are absent.
- Detection needs network access (a git shallow fetch of the upstream repo);
  offline simply shows no button.
