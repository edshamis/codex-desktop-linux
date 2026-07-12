"use strict";

const DEFAULT_MAX_OPEN_PRS = 2;

function parseMaxOpenPullRequests(rawValue, warn = () => {}) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";

  if (/^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  warn(
    `MAX_OPEN_PRS_PER_CONTRIBUTOR must be a positive integer; using ${DEFAULT_MAX_OPEN_PRS}.`,
  );
  return DEFAULT_MAX_OPEN_PRS;
}

function buildLimitComment(limit, count) {
  return `Thanks for contributing. This repository allows a maximum of **${limit} active pull requests per contributor**. You currently have **${count} open pull requests**, so this pull request is being closed automatically. Please finish or close one of your existing pull requests before opening another.`;
}

function shouldClosePullRequest({ action, currentNumber, limit, openPullRequests }) {
  if (openPullRequests.length <= limit) {
    return false;
  }

  if (action === "reopened") {
    return true;
  }

  const retainedNumbers = openPullRequests
    .map((pullRequest) => pullRequest.number)
    .sort((left, right) => left - right)
    .slice(0, limit);

  return !retainedNumbers.includes(currentNumber);
}

async function enforcePullRequestLimit({ context, core, github, rawLimit }) {
  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    throw new Error("The workflow event does not contain a pull request.");
  }

  if (pullRequest.user?.type === "Bot") {
    core.info(`Skipping pull request #${pullRequest.number} from a bot account.`);
    return { action: "skipped-bot" };
  }

  const limit = parseMaxOpenPullRequests(rawLimit, (message) => core.warning(message));
  const author = pullRequest.user.login;
  const authorLogin = author.toLowerCase();
  const allOpenPullRequests = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    per_page: 100,
  });
  const authorOpenPullRequests = allOpenPullRequests.filter(
    (candidate) => candidate.user?.login?.toLowerCase() === authorLogin,
  );

  if (!authorOpenPullRequests.some((candidate) => candidate.number === pullRequest.number)) {
    core.warning(
      `Pull request #${pullRequest.number} was not present in the open pull request list; leaving it unchanged.`,
    );
    return { action: "skipped-missing", count: authorOpenPullRequests.length, limit };
  }

  const shouldClose = shouldClosePullRequest({
    action: context.payload.action,
    currentNumber: pullRequest.number,
    limit,
    openPullRequests: authorOpenPullRequests,
  });

  if (!shouldClose) {
    core.info(
      `${author} has ${authorOpenPullRequests.length} open pull request(s); the configured limit is ${limit}.`,
    );
    return { action: "allowed", count: authorOpenPullRequests.length, limit };
  }

  const body = buildLimitComment(limit, authorOpenPullRequests.length);
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: pullRequest.number,
    body,
  });
  await github.rest.pulls.update({
    ...context.repo,
    pull_number: pullRequest.number,
    state: "closed",
  });

  core.notice(`Closed pull request #${pullRequest.number} because ${author} exceeded the limit.`);
  return { action: "closed", count: authorOpenPullRequests.length, limit };
}

module.exports = {
  DEFAULT_MAX_OPEN_PRS,
  buildLimitComment,
  enforcePullRequestLimit,
  parseMaxOpenPullRequests,
  shouldClosePullRequest,
};
