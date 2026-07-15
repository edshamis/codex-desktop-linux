"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const patchMarker = "/*codex-linux-chatgpt-complete-history*/";
const projectPatchMarker = "/*codex-linux-chatgpt-all-projects*/";
const flatHistoryPatchMarker = "/*codex-linux-chatgpt-flat-history-sections*/";
const tppFeedPatchMarker = "/*codex-linux-chatgpt-tpp-history-feed*/";
const warning =
  "WARN: Could not find current ChatGPT history, TPP-feed, and project-section contracts - skipping complete history feature patch";

const tppTargetFilterPattern = new RegExp(
  `if\\((${identifier})\\.kind!==\`optimistic\`&&\\1\\.conversation\\.conversation_origin===\`tpp\`\\)return\\[\\];`,
  "gu",
);
const patchedTppTargetFilterPattern = new RegExp(
  `${escapeRegExp(patchMarker)}if\\(!1&&(${identifier})\\.kind!==\`optimistic\`&&\\1\\.conversation\\.conversation_origin===\`tpp\`\\)return\\[\\];`,
  "gu",
);
const tppPredicatePattern = new RegExp(
  `function (${identifier})\\((${identifier})\\)\\{let\\{conversation_origin:(${identifier})\\}=\\2;return \\3!==\`tpp\`\\}`,
  "gu",
);
const patchedTppPredicatePattern = new RegExp(
  `function (${identifier})\\((${identifier})\\)\\{let\\{conversation_origin:(${identifier})\\}=\\2;return \\3!==\`tpp\`\\|\\|\\3===\`tpp\`\\}`,
  "gu",
);
const projectCollapsePattern = new RegExp(
  `(${identifier})=(${identifier})\\.length>(${identifier}),(${identifier})=\\1&&!(${identifier})\\?\\2\\.filter\\((${identifier})\\):\\2`,
  "gu",
);
const patchedProjectCollapsePattern = new RegExp(
  `${escapeRegExp(projectPatchMarker)}(${identifier})=!1,(${identifier})=(${identifier})`,
  "gu",
);

function mergeConversationLists(primary, secondary) {
  const ids = new Set(primary.map((conversation) => conversation.id));
  return [
    ...primary,
    ...secondary.filter((conversation) => !ids.has(conversation.id)),
  ];
}

function buildQuickChatHistorySections(conversations) {
  const scheduled = [];
  const projects = new Map();
  const recent = [];

  for (const conversation of conversations) {
    if (conversation.isAutomationConversation) {
      scheduled.push(conversation);
      continue;
    }
    if (conversation.projectId != null && conversation.projectName != null) {
      const project = projects.get(conversation.projectId) ?? {
        key: conversation.projectId,
        kind: "project",
        label: conversation.projectName,
        items: [],
      };
      if (!conversation.isProjectPlaceholder) {
        project.items.push(conversation);
      }
      projects.set(conversation.projectId, project);
      continue;
    }
    recent.push(conversation);
  }

  return [
    ...(scheduled.length === 0
      ? []
      : [
          {
            key: "scheduled",
            kind: "scheduled",
            label: "Scheduled",
            items: scheduled,
          },
        ]),
    ...projects.values(),
    ...(recent.length === 0
      ? []
      : [
          {
            key: "recent",
            kind: "recent",
            label: "Recent chats",
            items: recent,
          },
        ]),
  ];
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

function applyChatgptCompleteHistoryPatch(source) {
  const targetFilters = matches(source, tppTargetFilterPattern);
  const patchedTargetFilters = matches(source, patchedTppTargetFilterPattern);
  const predicates = matches(source, tppPredicatePattern);
  const patchedPredicates = matches(source, patchedTppPredicatePattern);
  const projectCollapses = matches(source, projectCollapsePattern);
  const patchedProjectCollapses = matches(
    source,
    patchedProjectCollapsePattern,
  );
  const hasFlatHistoryPatch = source.includes(flatHistoryPatchMarker);
  const hasTppFeedPatch = source.includes(tppFeedPatchMarker);

  if (
    targetFilters.length === 0 &&
    patchedTargetFilters.length === 1 &&
    predicates.length === 0 &&
    patchedPredicates.length === 1 &&
    projectCollapses.length === 0 &&
    patchedProjectCollapses.length === 1 &&
    hasFlatHistoryPatch &&
    hasTppFeedPatch
  ) {
    return source;
  }

  if (
    targetFilters.length !== 1 ||
    patchedTargetFilters.length !== 0 ||
    predicates.length !== 1 ||
    patchedPredicates.length !== 0 ||
    projectCollapses.length !== 1 ||
    hasFlatHistoryPatch ||
    hasTppFeedPatch
  ) {
    console.warn(warning);
    return source;
  }

  const predicateName = predicates[0][1];
  const predicateUses = matches(
    source,
    new RegExp(`\\.filter\\(${escapeRegExp(predicateName)}\\)`, "gu"),
  );
  const [, overflowAlias, projectsAlias, projectLimitAlias, visibleAlias] =
    projectCollapses[0];
  const projectFilterAlias = projectCollapses[0][6];
  const projectFilterContract = new RegExp(
    `function ${escapeRegExp(projectFilterAlias)}\\((${identifier}),(${identifier})\\)\\{return \\2<${escapeRegExp(projectLimitAlias)}\\}`,
    "gu",
  );

  const historyParameters =
    "function Cve({optimisticConversationIdBySourceId:e,optimisticTitleByConversationId:t,recentFallbackTitle:n,sourceTargets:r}){return r.flatMap(r=>{";
  const patchedHistoryParameters = `${flatHistoryPatchMarker}function Cve({optimisticConversationIdBySourceId:e,optimisticTitleByConversationId:t,recentFallbackTitle:n,sourceTargets:r,projectNamesById:codexLinuxProjectNamesById}){let codexLinuxHistoryItems=r.flatMap(r=>{`;
  const historyProjection =
    "let i=PD(r.conversationId),a=r.kind===`optimistic`?e.get(r.conversationId)??i:i;return[{conversationId:a,recencyAt:r.recencyAt,title:(r.kind===`optimistic`?t.get(a):r.conversation.title)?.trim()||n}]})}";
  const patchedHistoryProjection =
    "let i=PD(r.conversationId),a=r.kind===`optimistic`?e.get(r.conversationId)??i:i,o=r.kind===`optimistic`?r.projectId??null:mD(r.conversation);return[{conversationId:a,isAutomationConversation:r.kind!==`optimistic`&&r.conversation.is_automation_conversation===!0,isProjectPlaceholder:!1,projectId:o,projectName:o==null?null:codexLinuxProjectNamesById.get(o)??null,recencyAt:r.recencyAt,title:(r.kind===`optimistic`?t.get(a):r.conversation.title)?.trim()||n}]});for(const[codexLinuxProjectId,codexLinuxProjectName]of codexLinuxProjectNamesById)codexLinuxHistoryItems.some(e=>e.projectId===codexLinuxProjectId)||codexLinuxHistoryItems.push({conversationId:`codex-linux-project:${codexLinuxProjectId}`,isAutomationConversation:!1,isProjectPlaceholder:!0,projectId:codexLinuxProjectId,projectName:codexLinuxProjectName,recencyAt:Number.NEGATIVE_INFINITY,title:codexLinuxProjectName});return codexLinuxHistoryItems}";
  const historyProjectionCall =
    "recentFallbackTitle:e,sourceTargets:[...k.pinnedTargets,...k.chatTargets]";
  const patchedHistoryProjectionCall =
    "recentFallbackTitle:e,sourceTargets:[...k.pinnedTargets,...k.chatTargets],projectNamesById:k.projectNamesById";
  const tppFeedEnable = "S=zi({enabled:l&&a,";
  const patchedTppFeedEnable = `${tppFeedPatchMarker}S=zi({enabled:l&&(a||i),`;
  const flatHistoryConversations =
    "O=l?a?(S.data??[]).filter(Bxe):(x.data?.pages??[]).flatMap(zxe):[]";
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
  const historyRows = "c=n.map(e)";
  const patchedHistoryRows =
    "c=a==null?n.filter(e=>!e.isProjectPlaceholder).map(e):codexLinuxRenderQuickChatHistorySections(n,e)";
  const historyRendererAnchor = "function hPe(e){";
  const mergeHelperSource = mergeConversationLists
    .toString()
    .replace(
      "function mergeConversationLists",
      "function codexLinuxMergeConversationLists",
    );
  const sectionHelperSource = buildQuickChatHistorySections
    .toString()
    .replace(
      "function buildQuickChatHistorySections",
      "function codexLinuxBuildQuickChatHistorySections",
    );
  const renderHelperSource =
    "function codexLinuxRenderQuickChatHistorySections(e,t){return codexLinuxBuildQuickChatHistorySections(e).flatMap(e=>[(0,u8.jsx)(`li`,{className:`mt-4 px-1 text-sm font-medium text-token-text-tertiary`,children:e.kind===`scheduled`?(0,u8.jsx)($,{id:`quickChat.history.scheduled`,defaultMessage:`Scheduled`,description:`Heading for scheduled-run conversations in full Quick Chat history`}):e.kind===`recent`?(0,u8.jsx)($,{id:`quickChat.history.recent`,defaultMessage:`Recent chats`,description:`Heading for projectless conversations in full Quick Chat history`}):e.label},`codex-linux-history-section:${e.key}`),...e.items.map(t)])}";
  const patchedHistoryRendererAnchor = `${mergeHelperSource}${sectionHelperSource}${renderHelperSource}${historyRendererAnchor}`;
  const literalContracts = [
    [historyParameters, patchedHistoryParameters],
    [historyProjection, patchedHistoryProjection],
    [historyProjectionCall, patchedHistoryProjectionCall],
    [tppFeedEnable, patchedTppFeedEnable],
    [flatHistoryConversations, patchedFlatHistoryConversations],
    [conversationError, patchedConversationError],
    [conversationLoading, patchedConversationLoading],
    [historyRows, patchedHistoryRows],
    [historyRendererAnchor, patchedHistoryRendererAnchor],
  ];

  if (
    predicateUses.length !== 1 ||
    matches(source, projectFilterContract).length !== 1 ||
    literalContracts.some(([contract]) => uniqueIndex(source, contract) < 0)
  ) {
    console.warn(warning);
    return source;
  }

  const edits = [
    {
      start: targetFilters[0].index,
      end: targetFilters[0].index + targetFilters[0][0].length,
      replacement: `${patchMarker}${targetFilters[0][0].replace("if(", "if(!1&&")}`,
    },
    {
      start: predicates[0].index,
      end: predicates[0].index + predicates[0][0].length,
      replacement: predicates[0][0].replace(
        "!==`tpp`}",
        "!==`tpp`||" + predicates[0][3] + "===`tpp`}",
      ),
    },
    {
      start: projectCollapses[0].index,
      end: projectCollapses[0].index + projectCollapses[0][0].length,
      replacement: `${projectPatchMarker}${overflowAlias}=!1,${visibleAlias}=${projectsAlias}`,
    },
  ];

  for (const [contract, replacement] of literalContracts) {
    const start = uniqueIndex(source, contract);
    edits.push({ start, end: start + contract.length, replacement });
  }

  let patched = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    patched =
      patched.slice(0, edit.start) + edit.replacement + patched.slice(edit.end);
  }
  return patched;
}

const descriptors = [
  {
    id: "complete-history",
    phase: "webview-asset",
    order: 20_750,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~page-.*\.js$/,
    missingDescription: "shared ChatGPT history and project bundle",
    skipDescription: "complete ChatGPT history feature patch",
    apply: applyChatgptCompleteHistoryPatch,
  },
];

module.exports = {
  applyChatgptCompleteHistoryPatch,
  buildQuickChatHistorySections,
  descriptors,
  flatHistoryPatchMarker,
  mergeConversationLists,
  patchMarker,
  projectPatchMarker,
  tppFeedPatchMarker,
  warning,
};
