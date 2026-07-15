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
  descriptors,
  historyPatchMarker,
  historyWarning,
  mergeConversationLists,
  tppFeedPatchMarker,
} = require("./patch.js");

const sharedSource = [
  "function Cve(r){return r.flatMap(r=>{if(r.kind!==`optimistic`&&r.conversation.conversation_origin===`tpp`)return[];return[r.conversation]})}",
  "function keep(e){let{conversation_origin:t}=e;return t!==`tpp`}",
  "function zi(e){return e}",
  "function zxe(e){return e.items}",
  "function Bxe(e){return e.is_starred!==!0}",
  "function EH(e){let{flatConversationHistory:i,tppOnly:a}=e===void 0?{}:e,l=!0,x={data:{pages:[{items:e.generic}]},isError:!1,isLoading:!1},y={isError:!1,isLoading:!1},S=zi({enabled:l&&a,data:e.tpp,isError:!1,isLoading:!1}),O=l?a?(S.data??[]).filter(Bxe):(x.data?.pages??[]).flatMap(zxe):[];return{items:O,isConversationError:l&&(a?S.isError:y.isError||x.isError),isConversationLoading:l&&(a?S.isLoading:y.isLoading||x.isLoading)}}",
  "function recent(e){return e.filter(keep)}",
  "const EQ=1;",
  "globalThis.historyTargets=Cve;globalThis.recent=recent;globalThis.source=EH;",
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
      ["feature:chatgpt-complete-history:complete-history"],
    );
  });
});

test("keeps phone and scheduled TPP conversations in recent history", () => {
  const patched = applyPatchTwice(
    applyChatgptCompleteHistoryPatch,
    sharedSource,
  );
  assert.equal(patched.includes(historyPatchMarker), true);
  assert.equal(patched.includes(tppFeedPatchMarker), true);
  assertParses(patched, "shared-history");

  const runnable = patched.replace(/export\{[^;]+;/u, "");
  const context = {};
  vm.runInNewContext(runnable, context);
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
      context.historyTargets(
        conversations.map((conversation) => ({
          kind: "recent",
          conversation,
        })),
      ),
    ).map((conversation) => conversation.id),
    ["desktop", "phone", "scheduled"],
  );
  assert.deepEqual(
    Array.from(context.recent(conversations)).map(({ id }) => id),
    ["desktop", "phone", "scheduled"],
  );
  assert.deepEqual(
    Array.from(
      context.source({
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
  const source = sharedSource.replace("return t!==`tpp`", "return t!=null");
  const result = captureWarnings(() =>
    applyChatgptCompleteHistoryPatch(source),
  );
  assert.equal(result.value, source);
  assert.deepEqual(result.warnings, [historyWarning]);
});

test("descriptor targets only the shared history chunk", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chatgpt-complete-history-assets-"),
  );
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(assetsDir, "app-initial~app-main~page-current.js"),
      sharedSource,
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
