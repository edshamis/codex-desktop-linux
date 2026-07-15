#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  applyChatgptCompleteHistoryPatch,
  descriptors,
  patchMarker,
  warning,
} = require("./patch.js");

const currentSource = [
  "function targets(r){return r.flatMap(r=>{if(r.kind!==`optimistic`&&r.conversation.conversation_origin===`tpp`)return[];return[r.conversation]})}",
  "function keep(e){let{conversation_origin:t}=e;return t!==`tpp`}",
  "function recent(e){return e.filter(keep)}",
  "function firstProjects(e,t){return t<limit}",
  "function projects(A,g){let B=A.length>limit,V=B&&!g?A.filter(firstProjects):A;return{hasOverflow:B,visible:V}}",
  "globalThis.historyTargets=targets;globalThis.recentConversations=recent;globalThis.visibleProjects=projects;",
].join("");

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function applyPatchTwice(source) {
  const patched = applyChatgptCompleteHistoryPatch(source);
  const second = captureWarnings(() =>
    applyChatgptCompleteHistoryPatch(patched),
  );
  assert.equal(second.value, patched);
  assert.deepEqual(second.warnings, []);
  return patched;
}

function withFeatureConfig(enabled, callback) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chatgpt-complete-history-"),
  );
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(
      process.env.CODEX_LINUX_FEATURES_CONFIG,
      JSON.stringify({ enabled }),
    );
    return callback();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
        (descriptor) =>
          descriptor.id === "feature:chatgpt-complete-history:complete-history",
      ),
      false,
    );
  });
  withFeatureConfig(["chatgpt-complete-history"], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
        (descriptor) =>
          descriptor.id === "feature:chatgpt-complete-history:complete-history",
      ),
      true,
    );
  });
});

test("keeps regular, phone, and scheduled TPP conversations", () => {
  const patched = applyPatchTwice(currentSource);
  const context = { limit: 5 };
  vm.runInNewContext(patched, context);
  const conversations = [
    { title: "Desktop", conversation_origin: null },
    { title: "Phone", conversation_origin: "tpp" },
    {
      title: "Scheduled run",
      conversation_origin: "tpp",
      is_automation_conversation: true,
    },
  ];

  assert.deepEqual(
    Array.from(
      context.historyTargets(
        conversations.map((conversation) => ({
          kind: "recent",
          conversation,
        })),
      ),
    ).map((conversation) => conversation.title),
    ["Desktop", "Phone", "Scheduled run"],
  );
  assert.deepEqual(
    Array.from(context.recentConversations(conversations)).map(
      (conversation) => conversation.title,
    ),
    ["Desktop", "Phone", "Scheduled run"],
  );
  assert.equal(patched.includes(patchMarker), true);
});

test("keeps every ChatGPT project visible and removes false overflow", () => {
  const patched = applyPatchTwice(currentSource);
  const context = { limit: 5 };
  vm.runInNewContext(patched, context);
  const result = context.visibleProjects(
    ["one", "two", "three", "four", "five", "six", "seven"],
    false,
  );

  assert.deepEqual(Array.from(result.visible), [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
  ]);
  assert.equal(result.hasOverflow, false);
});

test("drift leaves the source byte-identical", () => {
  const source = currentSource.replace("return t!==`tpp`", "return t!=null");
  const result = captureWarnings(() =>
    applyChatgptCompleteHistoryPatch(source),
  );

  assert.equal(result.value, source);
  assert.deepEqual(result.warnings, [warning]);
});

test("a partial prior patch is rejected byte-identically", () => {
  const source = currentSource.replace(
    "if(r.kind!==`optimistic`",
    `${patchMarker}if(!1&&r.kind!==\`optimistic\``,
  );
  const result = captureWarnings(() =>
    applyChatgptCompleteHistoryPatch(source),
  );

  assert.equal(result.value, source);
  assert.deepEqual(result.warnings, [warning]);
});

test("descriptor targets and patches the shared page chunk", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chatgpt-complete-history-assets-"),
  );
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    const assetPath = path.join(
      assetsDir,
      "app-initial~app-main~page-current.js",
    );
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(assetPath, currentSource);

    assert.deepEqual(
      patchAssetFiles(
        tempDir,
        descriptors[0].pattern,
        descriptors[0].apply,
        "missing",
      ),
      { matched: 1, changed: 1 },
    );
    assert.match(fs.readFileSync(assetPath, "utf8"), /complete-history/);
    assert.equal(
      descriptors[0].pattern.test("app-initial~app-main~other-current.js"),
      false,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
