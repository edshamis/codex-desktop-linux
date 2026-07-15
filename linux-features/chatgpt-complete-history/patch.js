"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const historyPatchMarker = "/*codex-linux-chatgpt-complete-history*/";
const tppFeedPatchMarker = "/*codex-linux-chatgpt-tpp-history-feed*/";
const hookExportPatchMarker = "/*codex-linux-chatgpt-source-export*/";
const cloudProjectsPatchMarker = "/*codex-linux-chatgpt-cloud-projects*/";
const cloudScheduledPatchMarker =
  "/*codex-linux-chatgpt-cloud-scheduled-runs*/";
const historyWarning =
  "WARN: Could not find current ChatGPT history and source-export contracts - skipping complete history feature patch";
const projectsWarning =
  "WARN: Could not find current main Projects cloud-row contracts - skipping complete history Projects patch";
const scheduledWarning =
  "WARN: Could not find current main Scheduled cloud-run contracts - skipping complete history Scheduled patch";

const tppTargetFilterPattern = new RegExp(
  `if\\((${identifier})\\.kind!==\`optimistic\`&&\\1\\.conversation\\.conversation_origin===\`tpp\`\\)return\\[\\];`,
  "gu",
);
const patchedTppTargetFilterPattern = new RegExp(
  `${escapeRegExp(historyPatchMarker)}if\\(!1&&(${identifier})\\.kind!==\`optimistic\`&&\\1\\.conversation\\.conversation_origin===\`tpp\`\\)return\\[\\];`,
  "gu",
);
const tppPredicatePattern = new RegExp(
  `function (${identifier})\\((${identifier})\\)\\{let\\{conversation_origin:(${identifier})\\}=\\2;return \\3!==\`tpp\`\\}`,
  "gu",
);
const patchedTppPredicatePattern = new RegExp(
  `${escapeRegExp(historyPatchMarker)}function (${identifier})\\((${identifier})\\)\\{let\\{conversation_origin:(${identifier})\\}=\\2;return!0\\}`,
  "gu",
);
const sharedImportPattern =
  /import\{([^{}]+)\}from"(\.\/app-initial~app-main~page-[^"]+\.js)";/gu;

function mergeConversationLists(primary, secondary) {
  const ids = new Set(primary.map((conversation) => conversation.id));
  return [
    ...primary,
    ...secondary.filter((conversation) => !ids.has(conversation.id)),
  ];
}

function buildCloudProjectRows(projectNamesById) {
  return [...projectNamesById]
    .map(([projectId, projectName]) => ({
      id: `chatgpt:${projectId}`,
      kind: "cloud",
      modifiedAt: null,
      name: projectName,
      projectId,
      sourceCount: 1,
      sources: [],
      sourceSearchText: "ChatGPT cloud",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildCloudScheduledRuns(chatTargets) {
  const runsById = new Map();
  for (const target of chatTargets) {
    const conversation = target.conversation;
    if (conversation?.is_automation_conversation !== true) continue;
    const conversationId = target.conversationId ?? conversation.id;
    if (conversationId == null) continue;
    const run = {
      conversationId,
      recencyAt: target.recencyAt ?? 0,
      title: conversation.title?.trim() || "Scheduled ChatGPT task",
    };
    const previous = runsById.get(conversationId);
    if (previous == null || previous.recencyAt < run.recencyAt) {
      runsById.set(conversationId, run);
    }
  }
  return [...runsById.values()].sort(
    (left, right) => right.recencyAt - left.recencyAt,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)];
}

function uniqueIndex(source, value) {
  const index = source.indexOf(value);
  return index >= 0 && source.indexOf(value, index + value.length) === -1
    ? index
    : -1;
}

function applyEdits(source, edits) {
  let patched = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    patched =
      patched.slice(0, edit.start) + edit.replacement + patched.slice(edit.end);
  }
  return patched;
}

function literalEdits(source, contracts) {
  return contracts.map(([contract, replacement]) => {
    const start = uniqueIndex(source, contract);
    return { start, end: start + contract.length, replacement };
  });
}

function replaceSharedImport(source, marker) {
  const imports = matches(source, sharedImportPattern);
  if (imports.length !== 1) return null;
  const match = imports[0];
  const replacement = `${marker}import{codexLinuxUseChatGptSource as codexLinuxUseChatGptSource,${match[1]}}from"${match[2]}";`;
  return {
    start: match.index,
    end: match.index + match[0].length,
    replacement,
  };
}

function applyChatgptCompleteHistoryPatch(source) {
  const targetFilters = matches(source, tppTargetFilterPattern);
  const patchedTargetFilters = matches(source, patchedTppTargetFilterPattern);
  const predicates = matches(source, tppPredicatePattern);
  const patchedPredicates = matches(source, patchedTppPredicatePattern);
  const hasFeedPatch = source.includes(tppFeedPatchMarker);
  const hasHookExport = source.includes(hookExportPatchMarker);

  if (
    targetFilters.length === 0 &&
    patchedTargetFilters.length === 1 &&
    predicates.length === 0 &&
    patchedPredicates.length === 1 &&
    hasFeedPatch &&
    hasHookExport
  ) {
    return source;
  }

  const tppFeedEnable = "S=zi({enabled:l&&a,";
  const patchedTppFeedEnable = `${tppFeedPatchMarker}S=zi({enabled:l&&(a||i),`;
  const flatHistoryConversations =
    "O=l?a?(S.data??[]).filter(Bxe):(x.data?.pages??[]).flatMap(zxe):[]";
  const mergeHelperSource = mergeConversationLists
    .toString()
    .replace(
      "function mergeConversationLists",
      "function codexLinuxMergeConversationLists",
    );
  const historyHookAnchor = "function EH(e){";
  const patchedHistoryHookAnchor = `${mergeHelperSource}${historyHookAnchor}`;
  const patchedFlatHistoryConversations =
    "O=l?a?(S.data??[]).filter(Bxe):i?codexLinuxMergeConversationLists((x.data?.pages??[]).flatMap(zxe),(S.data??[]).filter(Bxe)):(x.data?.pages??[]).flatMap(zxe):[]";
  const conversationError =
    "isConversationError:l&&(a?S.isError:y.isError||x.isError)";
  const patchedConversationError =
    "isConversationError:l&&(a?S.isError:y.isError||x.isError||i&&S.isError)";
  const conversationLoading =
    "isConversationLoading:l&&(a?S.isLoading:y.isLoading||x.isLoading)";
  const patchedConversationLoading =
    "isConversationLoading:l&&(a?S.isLoading:y.isLoading||x.isLoading||i&&S.isLoading)";
  const exportAnchor = "export{EQ as $,";
  const patchedExportAnchor = `${hookExportPatchMarker}export{EH as codexLinuxUseChatGptSource,EQ as $,`;
  const contracts = [
    [historyHookAnchor, patchedHistoryHookAnchor],
    [tppFeedEnable, patchedTppFeedEnable],
    [flatHistoryConversations, patchedFlatHistoryConversations],
    [conversationError, patchedConversationError],
    [conversationLoading, patchedConversationLoading],
    [exportAnchor, patchedExportAnchor],
  ];

  if (
    targetFilters.length !== 1 ||
    patchedTargetFilters.length !== 0 ||
    predicates.length !== 1 ||
    patchedPredicates.length !== 0 ||
    hasFeedPatch ||
    hasHookExport ||
    contracts.some(([contract]) => uniqueIndex(source, contract) < 0)
  ) {
    console.warn(historyWarning);
    return source;
  }

  const predicate = predicates[0];
  const edits = [
    {
      start: targetFilters[0].index,
      end: targetFilters[0].index + targetFilters[0][0].length,
      replacement: `${historyPatchMarker}${targetFilters[0][0].replace("if(", "if(!1&&")}`,
    },
    {
      start: predicate.index,
      end: predicate.index + predicate[0].length,
      replacement: `${historyPatchMarker}function ${predicate[1]}(${predicate[2]}){let{conversation_origin:${predicate[3]}}=${predicate[2]};return!0}`,
    },
    ...literalEdits(source, contracts),
  ];
  return applyEdits(source, edits);
}

function applyMainProjectsPatch(source) {
  const hasPatch = source.includes(cloudProjectsPatchMarker);
  const hasImport = source.includes(
    "codexLinuxUseChatGptSource as codexLinuxUseChatGptSource",
  );
  if (hasPatch && hasImport) return source;

  const importEdit = replaceSharedImport(source, cloudProjectsPatchMarker);
  const helperAnchor = "function pn(){";
  const hookContract =
    "let{groups:s,hasLoadedWorkspaceRootOptions:c,isWorkspaceRootOptionsLoading:l}=w(R,o),[u,d]=(0,Q.useState)(``)";
  const patchedHookContract =
    "let{groups:s,hasLoadedWorkspaceRootOptions:c,isWorkspaceRootOptionsLoading:l}=w(R,o),codexLinuxChatGptSource=codexLinuxUseChatGptSource(),codexLinuxCloudProjectRows=codexLinuxBuildCloudProjectRows(codexLinuxChatGptSource.projectNamesById),[u,d]=(0,Q.useState)(``)";
  const memoContract =
    "if(e[4]!==y||e[5]!==c||e[6]!==t||e[7]!==l||e[8]!==i||e[9]!==u||e[10]!==g||e[11]!==x||e[12]!==_||e[13]!==m||e[14]!==f||e[15]!==T||e[16]!==v||e[17]!==s){";
  const patchedMemoContract = `if(!0||e[4]!==y||e[5]!==c||e[6]!==t||e[7]!==l||e[8]!==i||e[9]!==u||e[10]!==g||e[11]!==x||e[12]!==_||e[13]!==m||e[14]!==f||e[15]!==T||e[16]!==v||e[17]!==s){`;
  const rowsContract = "cloudRows:void 0,groups:s";
  const patchedRowsContract = "cloudRows:codexLinuxCloudProjectRows,groups:s";
  const emptyContract = "r=c&&!l&&s.length===0";
  const patchedEmptyContract =
    "r=c&&!l&&s.length===0&&codexLinuxCloudProjectRows.length===0";
  const renderContract =
    "return e.kind===`cloud`?null:(0,$.jsx)(yn,{expanded:t,onShowAllChange:t=>q(e.projectId,t),onToggleExpanded:()=>G(e.id),row:e,showAll:x.has(e.projectId)},e.id)";
  const patchedRenderContract =
    "return e.kind===`cloud`?(0,$.jsx)(codexLinuxCloudProjectRow,{row:e},e.id):(0,$.jsx)(yn,{expanded:t,onShowAllChange:t=>q(e.projectId,t),onToggleExpanded:()=>G(e.id),row:e,showAll:x.has(e.projectId)},e.id)";
  const buildHelperSource = buildCloudProjectRows
    .toString()
    .replace(
      "function buildCloudProjectRows",
      "function codexLinuxBuildCloudProjectRows",
    );
  const rowHelperSource =
    'function codexLinuxCloudProjectRow({row:e}){let t=`https://chatgpt.com/g/${encodeURIComponent(e.projectId)}/project`;return(0,$.jsx)(`a`,{href:t,target:`_blank`,rel:`noreferrer`,"data-project-row":!0,className:k(tn,`min-h-[70px] items-center border-b border-token-border px-0 py-2 text-base hover:bg-token-list-hover-background`),children:(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(`span`,{className:`min-w-0 truncate text-token-foreground`,children:e.name}),(0,$.jsx)(`span`,{className:`min-w-0 truncate text-token-text-secondary max-[920px]:hidden`,children:`ChatGPT cloud`}),(0,$.jsx)(`span`,{className:`text-token-description-foreground max-[680px]:hidden`,children:`—`}),(0,$.jsx)(`span`,{className:`pr-2 text-right text-sm text-token-text-secondary`,children:`Open`})]})})}';
  const contracts = [
    [helperAnchor, `${buildHelperSource}${rowHelperSource}${helperAnchor}`],
    [hookContract, patchedHookContract],
    [memoContract, patchedMemoContract],
    [rowsContract, patchedRowsContract],
    [emptyContract, patchedEmptyContract],
    [renderContract, patchedRenderContract],
  ];

  if (
    hasPatch ||
    hasImport ||
    importEdit == null ||
    contracts.some(([contract]) => uniqueIndex(source, contract) < 0)
  ) {
    console.warn(projectsWarning);
    return source;
  }
  return applyEdits(source, [importEdit, ...literalEdits(source, contracts)]);
}

function applyMainScheduledPatch(source) {
  const hasPatch = source.includes(cloudScheduledPatchMarker);
  const hasImport = source.includes(
    "codexLinuxUseChatGptSource as codexLinuxUseChatGptSource",
  );
  if (hasPatch && hasImport) return source;

  const importEdit = replaceSharedImport(source, cloudScheduledPatchMarker);
  const helperAnchor = "function ei(e){";
  const emptyPageContract = "children:e.length===0?(0,$.jsx)(li,{";
  const patchedEmptyPageContract = "children:e.length===0&&a?(0,$.jsx)(li,{";
  const pageChildrenContract = "children:[M,N,U]";
  const patchedPageChildrenContract =
    "children:[M,(0,Z.jsx)(codexLinuxCloudScheduledRows,{}),N,U]";
  const buildHelperSource = buildCloudScheduledRuns
    .toString()
    .replace(
      "function buildCloudScheduledRuns",
      "function codexLinuxBuildCloudScheduledRuns",
    );
  const rowsHelperSource =
    "function codexLinuxCloudScheduledRows(){let e=codexLinuxUseChatGptSource({tppOnly:!0}),t=codexLinuxBuildCloudScheduledRuns(e.chatTargets),n=(0,Z.jsx)(`a`,{href:`https://chatgpt.com/tasks`,target:`_blank`,rel:`noreferrer`,className:`text-sm text-token-text-link-foreground hover:underline`,children:`Manage in ChatGPT`}),r=e.isConversationLoading?(0,Z.jsx)(`div`,{className:`py-4 text-sm text-token-description-foreground`,children:`Loading ChatGPT cloud tasks…`}):e.isConversationError?(0,Z.jsx)(`div`,{className:`py-4 text-sm text-token-error-foreground`,children:`Could not load ChatGPT cloud tasks`}):t.length===0?(0,Z.jsx)(`div`,{className:`py-4 text-sm text-token-description-foreground`,children:`No synced ChatGPT scheduled runs yet`}):(0,Z.jsx)(`div`,{className:`flex flex-col gap-1`,role:`list`,children:t.map(e=>(0,Z.jsx)(`a`,{href:`/work/conversation/${encodeURIComponent(e.conversationId)}`,className:`flex min-h-14 items-center justify-between gap-4 rounded-lg px-3 py-2 hover:bg-token-list-hover-background`,role:`listitem`,children:(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsx)(`span`,{className:`min-w-0 truncate text-token-foreground`,children:e.title}),(0,Z.jsx)(`span`,{className:`shrink-0 text-sm text-token-description-foreground`,children:`ChatGPT cloud run`})]})},e.conversationId))});return(0,Z.jsxs)(`section`,{className:`mb-5 border-b border-token-border pb-5`,children:[(0,Z.jsxs)(`div`,{className:`mb-2 flex items-center justify-between gap-3`,children:[(0,Z.jsx)(`h2`,{className:`text-base font-medium text-token-foreground`,children:`ChatGPT cloud`} ),n]}),r]})}";
  const contracts = [
    [helperAnchor, `${buildHelperSource}${rowsHelperSource}${helperAnchor}`],
    [emptyPageContract, patchedEmptyPageContract],
    [pageChildrenContract, patchedPageChildrenContract],
  ];

  if (
    hasPatch ||
    hasImport ||
    importEdit == null ||
    contracts.some(([contract]) => uniqueIndex(source, contract) < 0)
  ) {
    console.warn(scheduledWarning);
    return source;
  }
  return applyEdits(source, [importEdit, ...literalEdits(source, contracts)]);
}

const descriptors = [
  {
    id: "complete-history",
    phase: "webview-asset",
    order: 20_750,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~page-.*\.js$/,
    missingDescription: "shared ChatGPT history bundle",
    skipDescription: "complete ChatGPT history feature patch",
    apply: applyChatgptCompleteHistoryPatch,
  },
  {
    id: "cloud-projects",
    phase: "webview-asset",
    order: 20_751,
    ciPolicy: "optional",
    pattern: /^projects-index-page-.*\.js$/,
    missingDescription: "main Projects page bundle",
    skipDescription: "ChatGPT cloud Projects feature patch",
    apply: applyMainProjectsPatch,
  },
  {
    id: "cloud-scheduled-runs",
    phase: "webview-asset",
    order: 20_752,
    ciPolicy: "optional",
    pattern: /^automations-page-.*\.js$/,
    missingDescription: "main Scheduled page bundle",
    skipDescription: "ChatGPT cloud Scheduled feature patch",
    apply: applyMainScheduledPatch,
  },
];

module.exports = {
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
};
