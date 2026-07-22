#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  descriptors,
  discoverCompleteHistoryContracts,
  hasNativeCompleteHistoryFeed,
  historyPatchMarker,
  historyWarning,
  patchCompleteHistory,
  patchQuickChatHistorySource,
} = require("./patch.js");

const quickChatSource = [
  "function tn({optimisticConversationIdBySourceId:e,optimisticTitleByConversationId:t,recentFallbackTitle:n,sourceTargets:r}){",
  "return r.flatMap(r=>{if(r.kind!==`optimistic`&&r.conversation.conversation_origin===`tpp`)return[];",
  "return[r.conversation]})}",
  "globalThis.historyTargets=tn;",
].join("");

const nativeHistorySource = [
  "function u(e){return e}",
  "function ut(e){return e.items}",
  "function lt(e){return e.items}",
  "function Ke(e){let{conversationFilter:a,flatConversationHistory:o}=e===void 0?{}:e,",
  "s=a===void 0?`all`:a,h=!0,b=s!==`tasks`,x=s!==`chats`,g={list:()=>[]},",
  "E=u({enabled:h&&b,queryFn:()=>g.list({excludeConversationOrigin:`tpp`,hideProjectConversations:o?!1:void 0})}),",
  "D=u({enabled:h&&x,queryFn:()=>g.list({conversationOrigin:`tpp`,hideProjectConversations:o?!1:void 0})}),",
  "I=h?[...(E.data?.pages??[]).flatMap(ut),...(D.data?.pages??[]).flatMap(lt)]:[];",
  "return{items:I,isConversationError:h&&(b&&E.isError||x&&D.isError),",
  "isConversationLoading:h&&(b&&E.isLoading||x&&D.isLoading)}}",
  "globalThis.nativeHistory=Ke;",
].join("");

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

function assertParses(source, name) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  try {
    const file = path.join(tempDir, `${name}.js`);
    fs.writeFileSync(file, source);
    const result = childProcess.spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createExtractedApp(files) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "chatgpt-complete-history-assets-"),
  );
  const assetsDir = path.join(root, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(assetsDir, name), source);
  }
  return { root, assetsDir };
}

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

test("feature is disabled until selected and uses semantic app discovery", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).some((descriptor) =>
        descriptor.id.startsWith("feature:chatgpt-complete-history:"),
      ),
      false,
    );
  });
  withFeatureConfig(["chatgpt-complete-history"], () => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .filter((descriptor) =>
          descriptor.id.startsWith("feature:chatgpt-complete-history:"),
        )
        .map(({ id, phase }) => [id, phase]),
      [
        [
          "feature:chatgpt-complete-history:complete-history",
          "extracted-app:post-webview",
        ],
      ],
    );
  });
});

test("Quick Chat keeps phone and scheduled TPP conversations", () => {
  const first = patchQuickChatHistorySource(quickChatSource);
  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.equal(first.source.includes(historyPatchMarker), true);
  assertParses(first.source, "quick-chat-history");

  const second = patchQuickChatHistorySource(first.source);
  assert.equal(second.matched, 1);
  assert.equal(second.changed, 0);
  assert.equal(second.source, first.source);

  const context = {};
  vm.runInNewContext(first.source, context);
  const conversations = [
    { id: "desktop", conversation_origin: null },
    { id: "phone", conversation_origin: "tpp" },
    {
      id: "scheduled",
      conversation_origin: "tpp",
      is_automation_conversation: true,
    },
  ];
  assert.deepEqual(
    Array.from(
      context.historyTargets({
        optimisticConversationIdBySourceId: new Map(),
        optimisticTitleByConversationId: new Map(),
        recentFallbackTitle: "Untitled chat",
        sourceTargets: conversations.map((conversation) => ({
          kind: "recent",
          conversation,
        })),
      }),
    ).map(({ id }) => id),
    ["desktop", "phone", "scheduled"],
  );
});

test("recognizes the current native split-and-merge history feed", () => {
  assert.equal(hasNativeCompleteHistoryFeed(nativeHistorySource), true);
  assert.equal(
    hasNativeCompleteHistoryFeed(
      nativeHistorySource.replace("...(D.data?.pages??[]).flatMap(lt)", ""),
    ),
    false,
  );
});

test("discovers renamed bundles, ignores decoys, and is idempotent", () => {
  const { root, assetsDir } = createExtractedApp({
    "app-random-current-name.js": quickChatSource,
    "history-another-random-name.js": nativeHistorySource,
    "decoy.js": "const conversationOrigin=`tpp`;",
  });
  try {
    const discovery = discoverCompleteHistoryContracts(root);
    assert.equal(discovery.verified, true);
    assert.equal(discovery.quickChat.name, "app-random-current-name.js");
    assert.equal(
      discovery.nativeHistory.name,
      "history-another-random-name.js",
    );

    const first = patchCompleteHistory(root);
    assert.equal(first.verified, true);
    assert.equal(first.changed, 1);
    assert.equal(
      fs.readFileSync(path.join(assetsDir, "decoy.js"), "utf8"),
      "const conversationOrigin=`tpp`;",
    );

    const second = patchCompleteHistory(root);
    assert.equal(second.verified, true);
    assert.equal(second.changed, 0);
    assert.equal(descriptors[0].status(first, []), "applied");
    assert.equal(descriptors[0].status(second, []), "already-applied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing or ambiguous contracts reject without writing", () => {
  for (const files of [
    { "quick.js": quickChatSource },
    {
      "quick-a.js": quickChatSource,
      "quick-b.js": quickChatSource,
      "history.js": nativeHistorySource,
    },
  ]) {
    const { root, assetsDir } = createExtractedApp(files);
    try {
      const before = new Map(
        fs
          .readdirSync(assetsDir)
          .map((name) => [
            name,
            fs.readFileSync(path.join(assetsDir, name), "utf8"),
          ]),
      );
      const result = captureWarnings(() => patchCompleteHistory(root));
      assert.equal(result.value.verified, false);
      assert.equal(result.value.changed, 0);
      assert.match(result.warnings[0], new RegExp(historyWarning));
      for (const [name, source] of before) {
        assert.equal(
          fs.readFileSync(path.join(assetsDir, name), "utf8"),
          source,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
