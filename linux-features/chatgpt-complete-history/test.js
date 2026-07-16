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
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  applyChatgptCompleteHistoryPatch,
  applyChatgptHistoryFeedPatch,
  applyChatgptHistoryPredicatePatch,
  descriptors,
  historyPatchMarker,
  historyWarning,
  mergeConversationLists,
  tppFeedPatchMarker,
} = require("./patch.js");

const historyFeedSource = [
  "function kc(r){return r.flatMap(r=>{if(r.kind!==`optimistic`&&r.conversation.conversation_origin===`tpp`)return[];return[r.conversation]})}",
  "function Pe(e){return{data:e.queryFn(),isError:!1,isLoading:!1}}",
  "function Dl(e){return e.items}",
  "function Ol(e){return e.is_starred!==!0}",
  "function ml(e){let{flatConversationHistory:n,tppOnly:r}=e===void 0?{}:e,i=n===void 0?!1:n,a=r===void 0?!1:r,u=!0,x={isError:!1,isLoading:!1},C={data:{pages:[{items:e.generic}]},isError:!1,isLoading:!1},w=Pe({enabled:u&&a,queryFn:()=>e.tpp}),j=u?a?(w.data??[]).filter(Ol):(C.data?.pages??[]).flatMap(Dl):[];return{items:j,isConversationError:u&&(a?w.isError:x.isError||C.isError),isConversationLoading:u&&(a?w.isLoading:x.isLoading||C.isLoading)}}",
  "const EQ=1;",
  "globalThis.historyTargets=kc;globalThis.source=ml;",
  "export{EQ as $,};",
].join("");

const historyPredicateSource = [
  "function Pz(e){let{conversation_origin:t}=e;return t!==`tpp`}",
  "function recent(e){return e.filter(Pz)}",
  "const EQ=1;",
  "globalThis.recent=recent;",
  "export{EQ as $,};",
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

function applyPatchTwice(apply, source) {
  const patched = apply(source);
  const second = captureWarnings(() => apply(patched));
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

function assertParses(source, name) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  try {
    const file = path.join(tempDir, `${name}.mjs`);
    fs.writeFileSync(file, source);
    const result = childProcess.spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected and exposes only history patching", () => {
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
        .map((descriptor) => descriptor.id),
      [
        "feature:chatgpt-complete-history:history-feed",
        "feature:chatgpt-complete-history:history-predicate",
      ],
    );
  });
});

test("keeps phone and scheduled TPP conversations in recent history", () => {
  const patchedFeed = applyPatchTwice(
    applyChatgptHistoryFeedPatch,
    historyFeedSource,
  );
  const patchedPredicate = applyPatchTwice(
    applyChatgptHistoryPredicatePatch,
    historyPredicateSource,
  );
  assert.equal(patchedFeed.includes(historyPatchMarker), true);
  assert.equal(patchedFeed.includes(tppFeedPatchMarker), true);
  assert.equal(patchedPredicate.includes(historyPatchMarker), true);
  assertParses(patchedFeed, "history-feed");
  assertParses(patchedPredicate, "history-predicate");

  const feedContext = {};
  vm.runInNewContext(patchedFeed.replace(/export\{[^;]+;/u, ""), feedContext);
  const predicateContext = {};
  vm.runInNewContext(
    patchedPredicate.replace(/export\{[^;]+;/u, ""),
    predicateContext,
  );
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
      feedContext.historyTargets(
        conversations.map((conversation) => ({
          kind: "recent",
          conversation,
        })),
      ),
    ).map((conversation) => conversation.id),
    ["desktop", "phone", "scheduled"],
  );
  assert.deepEqual(
    Array.from(predicateContext.recent(conversations)).map(({ id }) => id),
    ["desktop", "phone", "scheduled"],
  );
  assert.deepEqual(
    Array.from(
      feedContext.source({
        flatConversationHistory: true,
        generic: [conversations[0], conversations[1]],
        tpp: [conversations[1], conversations[2]],
      }).items,
    ).map(({ id }) => id),
    ["desktop", "phone", "scheduled"],
  );
});

test("conversation-list merging prefers the generic feed", () => {
  assert.deepEqual(
    mergeConversationLists(
      [{ id: "desktop" }, { id: "shared" }],
      [{ id: "shared" }, { id: "scheduled" }],
    ).map((conversation) => conversation.id),
    ["desktop", "shared", "scheduled"],
  );
});

test("drift leaves each asset byte-identical", () => {
  const feedSource = historyFeedSource.replace(
    "w=Pe({enabled:u&&a,",
    "w=Pe({enabled:u,",
  );
  const feedResult = captureWarnings(() =>
    applyChatgptHistoryFeedPatch(feedSource),
  );
  assert.equal(feedResult.value, feedSource);
  assert.deepEqual(feedResult.warnings, [historyWarning]);

  const predicateSource = historyPredicateSource.replace(
    "return t!==`tpp`",
    "return t!=null",
  );
  const predicateResult = captureWarnings(() =>
    applyChatgptHistoryPredicatePatch(predicateSource),
  );
  assert.equal(predicateResult.value, predicateSource);
  assert.deepEqual(predicateResult.warnings, [historyWarning]);
});

test("descriptors target the current split history chunks", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chatgpt-complete-history-assets-"),
  );
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(
        assetsDir,
        "app-initial~app-main~quick-chat-window-page-current.js",
      ),
      historyFeedSource,
    );
    fs.writeFileSync(
      path.join(assetsDir, "app-initial~app-main~page-current.js"),
      historyPredicateSource,
    );

    for (const descriptor of descriptors) {
      assert.deepEqual(
        patchAssetFiles(
          tempDir,
          descriptor.pattern,
          descriptor.apply,
          "missing",
        ),
        { matched: 1, changed: 1 },
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feed descriptor does not retain the superseded combined page target", () => {
  assert.equal(
    descriptors[0].pattern.test("app-initial~app-main~page-current.js"),
    false,
  );
  assert.equal(
    descriptors[1].pattern.test(
      "app-initial~app-main~quick-chat-window-page-current.js",
    ),
    false,
  );
});

test("combined helper dispatches each current split contract", () => {
  assert.notEqual(
    applyChatgptCompleteHistoryPatch(historyFeedSource),
    historyFeedSource,
  );
  assert.notEqual(
    applyChatgptCompleteHistoryPatch(historyPredicateSource),
    historyPredicateSource,
  );
});
