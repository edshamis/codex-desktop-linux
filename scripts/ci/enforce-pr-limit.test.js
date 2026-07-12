"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_MAX_OPEN_PRS,
  buildLimitComment,
  enforcePullRequestLimit,
  parseMaxOpenPullRequests,
  shouldClosePullRequest,
} = require("./enforce-pr-limit");

function pullRequest(number, login = "contributor", extra = {}) {
  return {
    number,
    user: { login, type: "User" },
    ...extra,
  };
}

function createHarness({ action = "opened", current = pullRequest(3), open = [] } = {}) {
  const calls = [];
  const messages = { info: [], notice: [], warning: [] };
  const list = Symbol("pulls.list");
  const github = {
    paginate: async (method, options) => {
      calls.push(["paginate", method, options]);
      return open;
    },
    rest: {
      issues: {
        createComment: async (options) => calls.push(["comment", options]),
      },
      pulls: {
        list,
        update: async (options) => calls.push(["close", options]),
      },
    },
  };
  const context = {
    payload: { action, pull_request: current },
    repo: { owner: "owner", repo: "repository" },
  };
  const core = {
    info: (message) => messages.info.push(message),
    notice: (message) => messages.notice.push(message),
    warning: (message) => messages.warning.push(message),
  };

  return { calls, context, core, github, list, messages };
}

test("parseMaxOpenPullRequests accepts positive integers", () => {
  assert.equal(parseMaxOpenPullRequests("1"), 1);
  assert.equal(parseMaxOpenPullRequests(" 12 "), 12);
});

test("parseMaxOpenPullRequests falls back for missing and invalid values", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "abc", "999999999999999999999"]) {
    const warnings = [];
    assert.equal(parseMaxOpenPullRequests(value, (message) => warnings.push(message)), DEFAULT_MAX_OPEN_PRS);
    assert.equal(warnings.length, 1);
  }
});

test("buildLimitComment returns the required English comment", () => {
  assert.equal(
    buildLimitComment(2, 3),
    "Thanks for contributing. This repository allows a maximum of **2 active pull requests per contributor**. You currently have **3 open pull requests**, so this pull request is being closed automatically. Please finish or close one of your existing pull requests before opening another.",
  );
});

test("shouldClosePullRequest allows counts at or below the limit", () => {
  assert.equal(
    shouldClosePullRequest({
      action: "opened",
      currentNumber: 2,
      limit: 2,
      openPullRequests: [pullRequest(1), pullRequest(2)],
    }),
    false,
  );
});

test("shouldClosePullRequest preserves earlier PRs during concurrent openings", () => {
  const openPullRequests = [pullRequest(3), pullRequest(1), pullRequest(2), pullRequest(4)];
  assert.equal(
    shouldClosePullRequest({ action: "opened", currentNumber: 1, limit: 2, openPullRequests }),
    false,
  );
  assert.equal(
    shouldClosePullRequest({ action: "opened", currentNumber: 3, limit: 2, openPullRequests }),
    true,
  );
  assert.equal(
    shouldClosePullRequest({ action: "opened", currentNumber: 4, limit: 2, openPullRequests }),
    true,
  );
});

test("shouldClosePullRequest closes the current reopened PR above the limit", () => {
  assert.equal(
    shouldClosePullRequest({
      action: "reopened",
      currentNumber: 1,
      limit: 2,
      openPullRequests: [pullRequest(1), pullRequest(2), pullRequest(3)],
    }),
    true,
  );
});

test("enforcePullRequestLimit skips bot accounts", async () => {
  const current = pullRequest(3, "automation[bot]", { user: { login: "automation[bot]", type: "Bot" } });
  const harness = createHarness({ current, open: [current] });

  const result = await enforcePullRequestLimit({ ...harness, rawLimit: "2" });

  assert.deepEqual(result, { action: "skipped-bot" });
  assert.deepEqual(harness.calls, []);
});

test("enforcePullRequestLimit counts drafts across all base branches without closing at the limit", async () => {
  const current = pullRequest(2, "Contributor", { draft: true });
  const harness = createHarness({
    current,
    open: [pullRequest(1, "contributor"), current, pullRequest(4, "someone-else")],
  });

  const result = await enforcePullRequestLimit({ ...harness, rawLimit: "2" });

  assert.deepEqual(result, { action: "allowed", count: 2, limit: 2 });
  assert.deepEqual(harness.calls, [
    [
      "paginate",
      harness.list,
      { owner: "owner", repo: "repository", state: "open", per_page: 100 },
    ],
  ]);
});

test("enforcePullRequestLimit comments in English before closing the excess PR", async () => {
  const current = pullRequest(3);
  const harness = createHarness({
    current,
    open: [pullRequest(1), pullRequest(2, "CONTRIBUTOR", { draft: true }), current],
  });

  const result = await enforcePullRequestLimit({ ...harness, rawLimit: "2" });

  assert.deepEqual(result, { action: "closed", count: 3, limit: 2 });
  assert.equal(harness.calls[1][0], "comment");
  assert.deepEqual(harness.calls[1][1], {
    owner: "owner",
    repo: "repository",
    issue_number: 3,
    body: buildLimitComment(2, 3),
  });
  assert.equal(harness.calls[2][0], "close");
  assert.deepEqual(harness.calls[2][1], {
    owner: "owner",
    repo: "repository",
    pull_number: 3,
    state: "closed",
  });
});

test("enforcePullRequestLimit leaves an already-closed current PR unchanged on rerun", async () => {
  const current = pullRequest(3);
  const harness = createHarness({ current, open: [pullRequest(1), pullRequest(2)] });

  const result = await enforcePullRequestLimit({ ...harness, rawLimit: "2" });

  assert.deepEqual(result, { action: "skipped-missing", count: 2, limit: 2 });
  assert.equal(harness.messages.warning.length, 1);
  assert.equal(harness.calls.length, 1);
});

test("workflow uses the trusted pull_request_target configuration", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/contributor-pr-limit.yml"),
    "utf8",
  );

  assert.match(workflow, /pull_request_target:\n\s+types: \[opened, reopened\]/);
  assert.match(workflow, /contents: read\n\s+issues: write\n\s+pull-requests: write/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /MAX_OPEN_PRS_PER_CONTRIBUTOR: \$\{\{ vars\.MAX_OPEN_PRS_PER_CONTRIBUTOR \|\| '2' \}\}/,
  );
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head/);
});
