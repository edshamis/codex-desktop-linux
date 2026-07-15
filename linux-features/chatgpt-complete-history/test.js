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
  buildQuickChatHistorySections,
  descriptors,
  flatHistoryPatchMarker,
  mergeConversationLists,
  patchMarker,
  tppFeedPatchMarker,
  warning,
} = require("./patch.js");

const currentSource = [
  "function Cve({optimisticConversationIdBySourceId:e,optimisticTitleByConversationId:t,recentFallbackTitle:n,sourceTargets:r}){return r.flatMap(r=>{if(r.kind!==`optimistic`&&r.conversation.conversation_origin===`tpp`)return[];let i=PD(r.conversationId),a=r.kind===`optimistic`?e.get(r.conversationId)??i:i;return[{conversationId:a,recencyAt:r.recencyAt,title:(r.kind===`optimistic`?t.get(a):r.conversation.title)?.trim()||n}]})}",
  "function keep(e){let{conversation_origin:t}=e;return t!==`tpp`}",
  "function recent(e){return e.filter(keep)}",
  "function firstProjects(e,t){return t<limit}",
  "function projects(A,g){let B=A.length>limit,V=B&&!g?A.filter(firstProjects):A;return{hasOverflow:B,visible:V}}",
  "function feed(l,a,i,x,y,tppData){let S=zi({enabled:l&&a,data:tppData,isError:!1,isLoading:!1,queryFn:async()=>[],queryKey:[],staleTime:0}),O=l?a?(S.data??[]).filter(Bxe):(x.data?.pages??[]).flatMap(zxe):[];return{items:O,isConversationError:l&&(a?S.isError:y.isError||x.isError),isConversationLoading:l&&(a?S.isLoading:y.isLoading||x.isLoading)}}",
  "function projectHistory(e,k){return Cve({optimisticConversationIdBySourceId:new Map,optimisticTitleByConversationId:new Map,recentFallbackTitle:e,sourceTargets:[...k.pinnedTargets,...k.chatTargets]})}",
  "function hPe(e){let{conversations:n,onNewChat:a}=e,c;if(!0){let e=e=>e.title;c=n.map(e)}return c}",
  "globalThis.historyTargets=(r,p)=>Cve({optimisticConversationIdBySourceId:new Map,optimisticTitleByConversationId:new Map,recentFallbackTitle:`Untitled`,sourceTargets:r,projectNamesById:p});globalThis.recentConversations=recent;globalThis.visibleProjects=projects;globalThis.flatFeed=feed;globalThis.renderHistory=hPe;",
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
  const context = {
    Bxe: (conversation) => conversation.is_starred !== true,
    PD: (id) => id,
    limit: 5,
    mD: (conversation) => conversation.gizmo_id ?? null,
    zi: (config) => config,
    zxe: (page) => page.items,
  };
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
        conversations.map((conversation, index) => ({
          kind: "recent",
          conversation,
          conversationId: String(index),
          recencyAt: index,
        })),
        new Map(),
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
  assert.equal(patched.includes(tppFeedPatchMarker), true);
  assert.equal(patched.includes(flatHistoryPatchMarker), true);
});

test("seeds project headings from the complete project-name map", () => {
  const patched = applyPatchTwice(currentSource);
  const context = {
    Bxe: (conversation) => conversation.is_starred !== true,
    PD: (id) => id,
    limit: 5,
    mD: (conversation) => conversation.gizmo_id ?? null,
    zi: (config) => config,
    zxe: (page) => page.items,
  };
  vm.runInNewContext(patched, context);

  const history = Array.from(
    context.historyTargets([], new Map([["g-p-life", "life"]])),
  );

  assert.deepEqual(
    history.map((conversation) => ({
      conversationId: conversation.conversationId,
      isProjectPlaceholder: conversation.isProjectPlaceholder,
      projectId: conversation.projectId,
      projectName: conversation.projectName,
    })),
    [
      {
        conversationId: "codex-linux-project:g-p-life",
        isProjectPlaceholder: true,
        projectId: "g-p-life",
        projectName: "life",
      },
    ],
  );
});

test("merges the dedicated TPP feed into flat history without duplicates", () => {
  const patched = applyPatchTwice(currentSource);
  const context = {
    Bxe: (conversation) => conversation.is_starred !== true,
    PD: (id) => id,
    limit: 5,
    mD: (conversation) => conversation.gizmo_id ?? null,
    zi: (config) => config,
    zxe: (page) => page.items,
  };
  vm.runInNewContext(patched, context);
  const desktop = { id: "desktop", title: "Desktop" };
  const scheduled = {
    id: "scheduled",
    title: "Weekly Git CLI Exercise",
    conversation_origin: "tpp",
    is_automation_conversation: true,
  };
  const result = context.flatFeed(
    true,
    false,
    true,
    { data: { pages: [{ items: [desktop, scheduled] }] } },
    { isError: false, isLoading: false },
    [scheduled],
  );

  assert.deepEqual(
    Array.from(result.items).map((conversation) => conversation.id),
    ["desktop", "scheduled"],
  );
});

test("builds Scheduled, project, and recent history sections", () => {
  const scheduled = {
    conversationId: "scheduled",
    isAutomationConversation: true,
    projectId: null,
    projectName: null,
  };
  const life = {
    conversationId: "life-chat",
    isAutomationConversation: false,
    projectId: "g-p-life",
    projectName: "life",
  };
  const recent = {
    conversationId: "recent",
    isAutomationConversation: false,
    projectId: null,
    projectName: null,
  };
  const emptyProject = {
    conversationId: "codex-linux-project:g-p-empty",
    isAutomationConversation: false,
    isProjectPlaceholder: true,
    projectId: "g-p-empty",
    projectName: "empty",
  };

  const sections = buildQuickChatHistorySections([
    scheduled,
    life,
    recent,
    emptyProject,
  ]);
  assert.deepEqual(
    sections.map((section) => [
      section.kind,
      section.label,
      section.items.map((conversation) => conversation.conversationId),
    ]),
    [
      ["scheduled", "Scheduled", ["scheduled"]],
      ["project", "life", ["life-chat"]],
      ["project", "empty", []],
      ["recent", "Recent chats", ["recent"]],
    ],
  );
});

test("renders headings only in the full history view", () => {
  const patched = applyPatchTwice(currentSource);
  const context = {
    $: "FormattedMessage",
    Bxe: (conversation) => conversation.is_starred !== true,
    PD: (id) => id,
    limit: 5,
    mD: (conversation) => conversation.gizmo_id ?? null,
    u8: {
      jsx: (type, props, key) => ({ key, props, type }),
    },
    zi: (config) => config,
    zxe: (page) => page.items,
  };
  vm.runInNewContext(patched, context);
  const conversations = [
    {
      isAutomationConversation: true,
      projectId: null,
      projectName: null,
      title: "Weekly Git CLI Exercise",
    },
    {
      isAutomationConversation: false,
      projectId: "g-p-life",
      projectName: "life",
      title: "Life chat",
    },
    {
      isAutomationConversation: false,
      isProjectPlaceholder: true,
      projectId: "g-p-empty",
      projectName: "empty",
      title: "empty",
    },
  ];

  const full = Array.from(
    context.renderHistory({ conversations, onNewChat: () => {} }),
  );
  assert.deepEqual(
    full.map((entry) =>
      typeof entry === "string"
        ? entry
        : typeof entry.props.children === "string"
          ? entry.props.children
          : entry.props.children.props.defaultMessage,
    ),
    ["Scheduled", "Weekly Git CLI Exercise", "life", "Life chat", "empty"],
  );
  assert.deepEqual(
    Array.from(context.renderHistory({ conversations, onNewChat: null })),
    ["Weekly Git CLI Exercise", "Life chat"],
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
