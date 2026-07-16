"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const historyPatchMarker = "/*codex-linux-chatgpt-complete-history*/";
const tppFeedPatchMarker = "/*codex-linux-chatgpt-tpp-history-feed*/";
const historyWarning =
  "WARN: Could not find current ChatGPT history contracts - skipping complete history feature patch";

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
function mergeConversationLists(primary, secondary) {
  const ids = new Set(primary.map((conversation) => conversation.id));
  return [
    ...primary,
    ...secondary.filter((conversation) => !ids.has(conversation.id)),
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

function applyChatgptCompleteHistoryPatch(source) {
  const hasFeedContract =
    tppTargetFilterPattern.test(source) ||
    patchedTppTargetFilterPattern.test(source) ||
    source.includes("function ml(e){") ||
    source.includes(tppFeedPatchMarker);
  const hasPredicateContract =
    tppPredicatePattern.test(source) || patchedTppPredicatePattern.test(source);

  tppTargetFilterPattern.lastIndex = 0;
  patchedTppTargetFilterPattern.lastIndex = 0;
  tppPredicatePattern.lastIndex = 0;
  patchedTppPredicatePattern.lastIndex = 0;

  if (!hasFeedContract && !hasPredicateContract) {
    console.warn(historyWarning);
    return source;
  }

  let patched = source;
  if (hasFeedContract) {
    patched = applyChatgptHistoryFeedPatch(patched);
  }
  if (hasPredicateContract) {
    patched = applyChatgptHistoryPredicatePatch(patched);
  }
  return patched;
}

function applyChatgptHistoryFeedPatch(source) {
  const targetFilters = matches(source, tppTargetFilterPattern);
  const patchedTargetFilters = matches(source, patchedTppTargetFilterPattern);
  const hasFeedPatch = source.includes(tppFeedPatchMarker);

  if (
    targetFilters.length === 0 &&
    patchedTargetFilters.length === 1 &&
    hasFeedPatch
  ) {
    return source;
  }

  const tppFeedEnable = "w=Pe({enabled:u&&a,";
  const patchedTppFeedEnable = `${tppFeedPatchMarker}w=Pe({enabled:u&&(a||i),`;
  const flatHistoryConversations =
    "j=u?a?(w.data??[]).filter(Ol):(C.data?.pages??[]).flatMap(Dl):[]";
  const mergeHelperSource = mergeConversationLists
    .toString()
    .replace(
      "function mergeConversationLists",
      "function codexLinuxMergeConversationLists",
    );
  const historyHookAnchor = "function ml(e){";
  const patchedHistoryHookAnchor = `${mergeHelperSource}${historyHookAnchor}`;
  const patchedFlatHistoryConversations =
    "j=u?a?(w.data??[]).filter(Ol):i?codexLinuxMergeConversationLists((C.data?.pages??[]).flatMap(Dl),(w.data??[]).filter(Ol)):(C.data?.pages??[]).flatMap(Dl):[]";
  const conversationError =
    "isConversationError:u&&(a?w.isError:x.isError||C.isError)";
  const patchedConversationError =
    "isConversationError:u&&(a?w.isError:x.isError||C.isError||i&&w.isError)";
  const conversationLoading =
    "isConversationLoading:u&&(a?w.isLoading:x.isLoading||C.isLoading)";
  const patchedConversationLoading =
    "isConversationLoading:u&&(a?w.isLoading:x.isLoading||C.isLoading||i&&w.isLoading)";
  const contracts = [
    [historyHookAnchor, patchedHistoryHookAnchor],
    [tppFeedEnable, patchedTppFeedEnable],
    [flatHistoryConversations, patchedFlatHistoryConversations],
    [conversationError, patchedConversationError],
    [conversationLoading, patchedConversationLoading],
  ];

  if (
    targetFilters.length !== 1 ||
    patchedTargetFilters.length !== 0 ||
    hasFeedPatch ||
    contracts.some(([contract]) => uniqueIndex(source, contract) < 0)
  ) {
    console.warn(historyWarning);
    return source;
  }

  const edits = [
    {
      start: targetFilters[0].index,
      end: targetFilters[0].index + targetFilters[0][0].length,
      replacement: `${historyPatchMarker}${targetFilters[0][0].replace("if(", "if(!1&&")}`,
    },
    ...literalEdits(source, contracts),
  ];
  return applyEdits(source, edits);
}

function applyChatgptHistoryPredicatePatch(source) {
  const predicates = matches(source, tppPredicatePattern);
  const patchedPredicates = matches(source, patchedTppPredicatePattern);

  if (predicates.length === 0 && patchedPredicates.length === 1) {
    return source;
  }
  if (predicates.length !== 1 || patchedPredicates.length !== 0) {
    console.warn(historyWarning);
    return source;
  }

  const predicate = predicates[0];
  return applyEdits(source, [
    {
      start: predicate.index,
      end: predicate.index + predicate[0].length,
      replacement: `${historyPatchMarker}function ${predicate[1]}(${predicate[2]}){let{conversation_origin:${predicate[3]}}=${predicate[2]};return!0}`,
    },
  ]);
}

const descriptors = [
  {
    id: "history-feed",
    phase: "webview-asset",
    order: 20_750,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~quick-chat-window-page-[A-Za-z0-9_-]+\.js$/,
    missingDescription: "ChatGPT history feed bundle",
    skipDescription: "complete ChatGPT history feed patch",
    apply: applyChatgptHistoryFeedPatch,
  },
  {
    id: "history-predicate",
    phase: "webview-asset",
    order: 20_751,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~page-[A-Za-z0-9_-]+\.js$/,
    missingDescription: "ChatGPT recent-history page bundle",
    skipDescription: "complete ChatGPT history predicate patch",
    apply: applyChatgptHistoryPredicatePatch,
  },
];

module.exports = {
  applyChatgptCompleteHistoryPatch,
  applyChatgptHistoryFeedPatch,
  applyChatgptHistoryPredicatePatch,
  descriptors,
  historyPatchMarker,
  historyWarning,
  mergeConversationLists,
  tppFeedPatchMarker,
};
