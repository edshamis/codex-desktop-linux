//! Wrapper-repo update detection.
//!
//! Beyond tracking the upstream Codex DMG, the updater detects when the
//! *wrapper* itself (this repository — new Linux features, patches, fixes) has
//! advanced upstream. Detection is git-only and works for ALL install types
//! (packaged .deb/.rpm/pacman and user-local install.sh) — it does not require a
//! local git checkout:
//!
//! - The installed wrapper build time is read from the installed package version
//!   (`YYYY.MM.DD.HHMMSS+<dmg-sha>`), available on every install. The `+suffix`
//!   is the upstream DMG sha, NOT a wrapper commit, so it is never used as one.
//! - The upstream HEAD commit date and `CHANGELOG.md` are obtained with a git
//!   shallow fetch (`git fetch --depth 1`) into a cache dir under the updater
//!   workspace. This never touches the user's working tree and needs only git
//!   (no GitHub API, no curl).
//!
//! A newer wrapper build is available when the upstream HEAD commit date is
//! later than the installed build timestamp.

use anyhow::Result;
use chrono::{DateTime, NaiveDateTime, Utc};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

use crate::changelog;

/// Default upstream wrapper repository, used when no remote can be resolved from
/// config or a local checkout. This is the project's canonical "all users" repo.
const DEFAULT_WRAPPER_REMOTE: &str = "https://github.com/ilysenko/codex-desktop-linux.git";

/// Result of comparing the installed wrapper build against the upstream head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapperUpdate {
    /// Installed build timestamp, formatted `YYYY.MM.DD.HHMMSS` (when known).
    pub installed_build: Option<String>,
    /// Upstream HEAD commit sha.
    pub candidate_commit: String,
    /// Upstream HEAD commit date (RFC3339).
    pub candidate_date: String,
    /// Curated CHANGELOG sections, or a short fallback line.
    pub changelog: String,
}

/// Runs a git command, returning trimmed stdout on success (read-only helper).
fn git_capture(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// True when `repo` is a git working tree.
fn is_git_checkout(repo: &Path) -> bool {
    git_capture(&[
        "-C",
        &repo.to_string_lossy(),
        "rev-parse",
        "--is-inside-work-tree",
    ])
    .map(|value| value == "true")
    .unwrap_or(false)
}

/// Parses the `YYYY.MM.DD.HHMMSS` build timestamp from a package version such as
/// `2026.05.19.214329+6d440c71`. Returns the parsed UTC time and the formatted
/// prefix. Anything that does not match the expected shape yields `None`.
pub fn parse_build_timestamp(package_version: &str) -> Option<(DateTime<Utc>, String)> {
    let prefix = package_version.split('+').next()?.trim();
    let parsed = NaiveDateTime::parse_from_str(prefix, "%Y.%m.%d.%H%M%S").ok()?;
    Some((parsed.and_utc(), prefix.to_string()))
}

/// Resolves the wrapper remote URL: explicit config value, else the checkout's
/// `origin` URL when a checkout exists, else the canonical upstream default.
pub fn resolve_remote(config_remote: &str, bundle_root: &Path) -> String {
    let trimmed = config_remote.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    if is_git_checkout(bundle_root) {
        if let Some(origin) = git_capture(&[
            "-C",
            &bundle_root.to_string_lossy(),
            "remote",
            "get-url",
            "origin",
        ]) {
            return origin;
        }
    }
    DEFAULT_WRAPPER_REMOTE.to_string()
}

/// Shallow-fetches `branch` from `remote` into a dedicated cache repo under
/// `cache_dir`, returning that repo path. The cache repo is created on first use
/// and reused afterwards. Only the cache dir is written — never the user's tree.
fn shallow_fetch(remote: &str, branch: &str, cache_dir: &Path) -> Option<PathBuf> {
    let repo = cache_dir.join("wrapper-detect.git");
    if !repo.join("HEAD").exists() {
        std::fs::create_dir_all(&repo).ok()?;
        let status = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .arg(&repo)
            .status()
            .ok()?;
        if !status.success() {
            return None;
        }
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["fetch", "--depth", "1", "--quiet", remote, branch])
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    Some(repo)
}

/// Reads the upstream HEAD sha, commit date, and `CHANGELOG.md` from a shallow
/// fetch cache repo. Returns `(sha, rfc3339_date, changelog_markdown)`.
fn read_fetch_head(repo: &Path) -> Option<(String, String, Option<String>)> {
    let repo_str = repo.to_string_lossy().to_string();
    let sha = git_capture(&["-C", &repo_str, "rev-parse", "FETCH_HEAD"])?;
    let date = git_capture(&["-C", &repo_str, "log", "-1", "--format=%cI", "FETCH_HEAD"])?;
    let changelog = git_capture(&["-C", &repo_str, "show", "FETCH_HEAD:CHANGELOG.md"]);
    Some((sha, date, changelog))
}

/// Builds the "what changed" text. Prefers curated CHANGELOG sections newer than
/// the installed build (matched by date is not possible per-section, so we show
/// the `[Unreleased]` + all released sections above any that predate the build
/// is not reliable; instead we surface the full curated changelog head). Falls
/// back to a short line when no changelog is available.
fn build_changelog(changelog_md: Option<&str>) -> String {
    if let Some(md) = changelog_md {
        let sections = changelog::parse_changelog(md);
        if !sections.is_empty() {
            // Surface the top sections (Unreleased + newest releases). Cap to a
            // few sections so the tooltip/notification stays readable.
            let head: Vec<String> = sections
                .iter()
                .take(4)
                .map(|s| format!("## {}\n\n{}", s.version, s.body))
                .collect();
            if !head.is_empty() {
                return head.join("\n\n");
            }
        }
    }
    "Wrapper update available (changelog unavailable).".to_string()
}

/// Detects whether the upstream wrapper repo has a newer build than the one
/// installed. `installed_version` is the package version string
/// (`install::installed_package_version()`); `bundle_root` is used only to
/// resolve a remote URL when one is not configured. `cache_dir` holds the
/// shallow-fetch repo. Returns `Ok(None)` when up to date, offline, or when the
/// installed build timestamp can't be parsed. Never mutates the working tree.
pub fn detect_wrapper_update(
    installed_version: &str,
    config_remote: &str,
    branch: &str,
    bundle_root: &Path,
    cache_dir: &Path,
) -> Result<Option<WrapperUpdate>> {
    let Some((installed_time, installed_build)) = parse_build_timestamp(installed_version) else {
        return Ok(None);
    };

    let remote = resolve_remote(config_remote, bundle_root);
    let Some(repo) = shallow_fetch(&remote, branch, cache_dir) else {
        return Ok(None);
    };
    let Some((candidate_commit, candidate_date, changelog_md)) = read_fetch_head(&repo) else {
        return Ok(None);
    };

    let Ok(candidate_time) = DateTime::parse_from_rfc3339(&candidate_date) else {
        return Ok(None);
    };

    if candidate_time.with_timezone(&Utc) <= installed_time {
        return Ok(None);
    }

    Ok(Some(WrapperUpdate {
        installed_build: Some(installed_build),
        candidate_commit,
        candidate_date,
        changelog: build_changelog(changelog_md.as_deref()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::env_lock;
    use std::process::Command;
    use tempfile::tempdir;

    fn git_bin() -> PathBuf {
        if let Some(explicit) = std::env::var_os("GIT") {
            return PathBuf::from(explicit);
        }
        for candidate in ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"] {
            if Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
        PathBuf::from("git")
    }

    fn git(repo: &Path, args: &[&str]) {
        let output = Command::new(git_bin())
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Creates a local "upstream" repo with one commit at a fixed date so the
    /// shallow fetch + date comparison is deterministic.
    fn init_origin(dir: &Path, commit_date: &str) {
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(
            dir.join("CHANGELOG.md"),
            "# Changelog\n\n## [0.9.0] - 2026-06-01\n\n### Added\n\n- New wrapper feature.\n",
        )
        .unwrap();
        git(dir, &["add", "-A"]);
        // Pin both author and committer dates so %cI is stable.
        let output = Command::new(git_bin())
            .arg("-C")
            .arg(dir)
            .args(["commit", "-q", "-m", "release"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_DATE", commit_date)
            .env("GIT_COMMITTER_DATE", commit_date)
            .output()
            .expect("spawn git commit");
        assert!(output.status.success(), "git commit failed");
    }

    #[test]
    fn parse_build_timestamp_extracts_prefix() {
        let (time, prefix) = parse_build_timestamp("2026.05.19.214329+6d440c71").expect("parsed");
        assert_eq!(prefix, "2026.05.19.214329");
        assert_eq!(
            time.format("%Y-%m-%d %H:%M:%S").to_string(),
            "2026-05-19 21:43:29"
        );
        // No suffix is fine too.
        assert!(parse_build_timestamp("2026.05.19.214329").is_some());
        // Garbage yields None.
        assert!(parse_build_timestamp("not-a-version").is_none());
        assert!(parse_build_timestamp("1.2.3").is_none());
    }

    #[test]
    fn detects_newer_upstream_build() {
        let _g = env_lock();
        let origin = tempdir().unwrap();
        let cache = tempdir().unwrap();
        // Upstream commit dated well after the installed build.
        init_origin(origin.path(), "2026-06-01T12:00:00 +0000");

        let remote = origin.path().to_string_lossy().to_string();
        let update = detect_wrapper_update(
            "2026.05.19.214329+6d440c71",
            &remote,
            "main",
            origin.path(),
            cache.path(),
        )
        .unwrap()
        .expect("update detected");

        assert_eq!(update.candidate_commit.len(), 40);
        assert!(update.changelog.contains("New wrapper feature."));
        assert_eq!(update.installed_build.as_deref(), Some("2026.05.19.214329"));
    }

    #[test]
    fn no_update_when_installed_is_newer() {
        let _g = env_lock();
        let origin = tempdir().unwrap();
        let cache = tempdir().unwrap();
        // Upstream commit dated BEFORE the installed build.
        init_origin(origin.path(), "2026-01-01T00:00:00 +0000");

        let remote = origin.path().to_string_lossy().to_string();
        let result = detect_wrapper_update(
            "2026.05.19.214329+6d440c71",
            &remote,
            "main",
            origin.path(),
            cache.path(),
        )
        .unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn unparseable_installed_version_yields_none() {
        let _g = env_lock();
        let cache = tempdir().unwrap();
        let result = detect_wrapper_update(
            "not-a-version",
            DEFAULT_WRAPPER_REMOTE,
            "main",
            Path::new("/nonexistent"),
            cache.path(),
        )
        .unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn offline_or_bad_remote_yields_none() {
        let _g = env_lock();
        let cache = tempdir().unwrap();
        // A remote that cannot be fetched -> graceful None, no panic.
        let result = detect_wrapper_update(
            "2026.05.19.214329+6d440c71",
            "/nonexistent/repo.git",
            "main",
            Path::new("/nonexistent"),
            cache.path(),
        )
        .unwrap();
        assert_eq!(result, None);
    }
}
