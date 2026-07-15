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
  applyMainProjectsPatch,
  applyMainScheduledPatch,
  buildCloudProjectRows,
  buildCloudScheduledRuns,
  cloudProjectsPatchMarker,
  cloudScheduledPatchMarker,
  descriptors,
  historyPatchMarker,
  historyWarning,
  hookExportPatchMarker,
  mergeConversationLists,
  projectsWarning,
  scheduledWarning,
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

const projectsSource = [
  'import{In as ht}from"./app-initial~app-main~page-current.js";',
  "function pn(){let e=[],t,r,i,o,w,R,Q,f,p,m,h,g,_,v,y=new Set,b,x=new Set,S,C,T,E,D,O,A,j,M,N,P,F,I,L,z,B,q,G;",
  "let{groups:s,hasLoadedWorkspaceRootOptions:c,isWorkspaceRootOptionsLoading:l}=w(R,o),[u,d]=(0,Q.useState)(``);",
  "if(e[4]!==y||e[5]!==c||e[6]!==t||e[7]!==l||e[8]!==i||e[9]!==u||e[10]!==g||e[11]!==x||e[12]!==_||e[13]!==m||e[14]!==f||e[15]!==T||e[16]!==v||e[17]!==s){",
  "let n=Wt({cloudRows:void 0,groups:s,projectWritableRoots:[],query:u,sortDirection:m,sortKey:f,tasks:T}),r=c&&!l&&s.length===0;",
  "return n.map(e=>{let t=y.has(e.id);return e.kind===`cloud`?null:(0,$.jsx)(yn,{expanded:t,onShowAllChange:t=>q(e.projectId,t),onToggleExpanded:()=>G(e.id),row:e,showAll:x.has(e.projectId)},e.id)})}}",
].join("");

const scheduledSource = [
  'import{In as ht}from"./app-initial~app-main~page-current.js";',
  "function ei(e){let M,N,U;return(0,Z.jsx)(`main`,{children:[M,N,U]})}",
  "function oi(){let e=[];return(0,$.jsx)(`div`,{children:e.length===0?(0,$.jsx)(li,{empty:!0}):(0,$.jsx)(ei,{automations:e})})}",
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

test("feature is disabled until selected and exposes all three patches", () => {
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
        "feature:chatgpt-complete-history:complete-history",
        "feature:chatgpt-complete-history:cloud-projects",
        "feature:chatgpt-complete-history:cloud-scheduled-runs",
      ],
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
  assert.equal(patched.includes(hookExportPatchMarker), true);
  assertParses(patched, "shared-history");

  const runnable = patched.replace(
    /\/\*codex-linux-chatgpt-source-export\*\/export\{[^;]+;/u,
    "",
  );
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

test("builds every ChatGPT cloud project row", () => {
  assert.deepEqual(
    buildCloudProjectRows(
      new Map([
        ["g-p-z", "zeta"],
        ["g-p-life", "life"],
      ]),
    ).map(({ id, kind, name, projectId }) => ({ id, kind, name, projectId })),
    [
      {
        id: "chatgpt:g-p-life",
        kind: "cloud",
        name: "life",
        projectId: "g-p-life",
      },
      {
        id: "chatgpt:g-p-z",
        kind: "cloud",
        name: "zeta",
        projectId: "g-p-z",
      },
    ],
  );
});

test("builds only scheduled ChatGPT cloud runs and deduplicates them", () => {
  const scheduled = {
    id: "scheduled",
    title: "Weekly Git CLI Exercise",
    is_automation_conversation: true,
  };
  assert.deepEqual(
    buildCloudScheduledRuns([
      { conversation: { id: "regular", title: "Regular" }, recencyAt: 30 },
      { conversation: scheduled, conversationId: "scheduled", recencyAt: 20 },
      { conversation: scheduled, conversationId: "scheduled", recencyAt: 40 },
    ]),
    [
      {
        conversationId: "scheduled",
        recencyAt: 40,
        title: "Weekly Git CLI Exercise",
      },
    ],
  );
});

test("patches the main Projects page instead of Quick Chat grouping", () => {
  const patched = applyPatchTwice(applyMainProjectsPatch, projectsSource);
  assert.equal(patched.includes(cloudProjectsPatchMarker), true);
  assert.match(patched, /cloudRows:codexLinuxCloudProjectRows/u);
  assert.match(patched, /codexLinuxCloudProjectRow/u);
  assert.match(patched, /className:k\(tn,/u);
  assert.match(patched, /max-\[920px\]:hidden/u);
  assert.doesNotMatch(
    patched,
    /grid-cols-\[minmax\(0,1fr\)_minmax\(8rem,.8fr\)/u,
  );
  assert.doesNotMatch(patched, /quickChat\.history\.(scheduled|recent)/u);
  assertParses(patched, "cloud-projects");
});

test("patches the main Scheduled page with cloud runs", () => {
  const patched = applyPatchTwice(applyMainScheduledPatch, scheduledSource);
  assert.equal(patched.includes(cloudScheduledPatchMarker), true);
  assert.match(patched, /codexLinuxCloudScheduledRows/u);
  assert.match(patched, /https:\/\/chatgpt\.com\/tasks/u);
  assertParses(patched, "cloud-scheduled-runs");
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
  for (const [apply, source, warning] of [
    [
      applyChatgptCompleteHistoryPatch,
      sharedSource.replace("return t!==`tpp`", "return t!=null"),
      historyWarning,
    ],
    [
      applyMainProjectsPatch,
      projectsSource.replace("cloudRows:void 0", "cloudRows:[]"),
      projectsWarning,
    ],
    [
      applyMainScheduledPatch,
      scheduledSource.replace("children:[M,N,U]", "children:[M,U]"),
      scheduledWarning,
    ],
  ]) {
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value, source);
    assert.deepEqual(result.warnings, [warning]);
  }
});

test("descriptors target and patch all three current page chunks", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chatgpt-complete-history-assets-"),
  );
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const fixtures = [
      ["app-initial~app-main~page-current.js", sharedSource],
      ["projects-index-page-current.js", projectsSource],
      ["automations-page-current.js", scheduledSource],
    ];
    for (const [name, source] of fixtures) {
      fs.writeFileSync(path.join(assetsDir, name), source);
    }

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
