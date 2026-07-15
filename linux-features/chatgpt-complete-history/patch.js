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
  const targetFilters = matches(source, tppTargetFilterPattern);
  const patchedTargetFilters = matches(source, patchedTppTargetFilterPattern);
  const predicates = matches(source, tppPredicatePattern);
  const patchedPredicates = matches(source, patchedTppPredicatePattern);
  const hasFeedPatch = source.includes(tppFeedPatchMarker);

  if (
    targetFilters.length === 0 &&
    patchedTargetFilters.length === 1 &&
    predicates.length === 0 &&
    patchedPredicates.length === 1 &&
    hasFeedPatch
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
    predicates.length !== 1 ||
    patchedPredicates.length !== 0 ||
    hasFeedPatch ||
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
];

module.exports = {
  applyChatgptCompleteHistoryPatch,
  descriptors,
  historyPatchMarker,
  historyWarning,
  mergeConversationLists,
  tppFeedPatchMarker,
};
