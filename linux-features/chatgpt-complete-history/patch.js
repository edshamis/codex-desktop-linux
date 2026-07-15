"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const patchMarker = "/*codex-linux-chatgpt-complete-history*/";
const projectPatchMarker = "/*codex-linux-chatgpt-all-projects*/";
const warning =
  "WARN: Could not find current ChatGPT history filters and project-collapse contract - skipping complete history feature patch";

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)];
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

  if (
    targetFilters.length === 0 &&
    patchedTargetFilters.length === 1 &&
    predicates.length === 0 &&
    patchedPredicates.length === 1 &&
    projectCollapses.length === 0 &&
    patchedProjectCollapses.length === 1
  ) {
    return source;
  }

  if (
    targetFilters.length !== 1 ||
    patchedTargetFilters.length !== 0 ||
    predicates.length !== 1 ||
    patchedPredicates.length !== 0 ||
    projectCollapses.length !== 1
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

  if (
    predicateUses.length !== 1 ||
    matches(source, projectFilterContract).length !== 1
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
  descriptors,
  patchMarker,
  projectPatchMarker,
  warning,
};
