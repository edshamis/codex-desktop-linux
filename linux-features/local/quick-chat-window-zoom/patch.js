"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../../scripts/patches/lib/minified-js.js");

const quickChatWindowSpacerExtraHeight = 48;
const quickChatWindowSpacerMaxHeight = `calc(var(--quick-chat-footer-height, 0px) + ${quickChatWindowSpacerExtraHeight}px)`;
const quickChatWindowTargetMarkers = [
  "data-quick-chat-thread-scroll-spacer",
  "initialScrollMode:",
  "isWindowZoomApplied:",
  "scrollOrigin:",
  ".floatingSurface",
  "bg-token-editor-background/55",
];
const quickChatWindowRootPrefixPattern =
  /([A-Za-z_$][\w$]*)===`floating`&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.floatingSurface,`[^`]*`\),\1===`window`&&/gu;
const patchedQuickChatWindowPattern =
  /([A-Za-z_$][\w$]*)===`floating`&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.floatingSurface,`[^`]*`\),\1===`window`&&\2\(\3\.zoomedViewport,`relative overflow-hidden bg-token-editor-background\/55`\)/gu;
const patchedQuickChatWindowScrollPattern =
  /[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)===`floating`\|\|\1===`window`,[A-Za-z_$][\w$]*=/gu;

function regexpMatches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function isQuickChatWindowZoomTarget(source) {
  return quickChatWindowTargetMarkers.every((marker) =>
    source.includes(marker),
  );
}

function findQuickChatWindowSpacerContract(currentSource) {
  const identifier = "[A-Za-z_$][\\w$]*";
  const scrollComponentPattern = new RegExp(
    `\\{children:${identifier},footer:${identifier},initialScrollMode:${identifier},isWindowZoomApplied:${identifier},scrollOrigin:${identifier},variant:(${identifier})\\}=${identifier}`,
    "gu",
  );
  const contracts = [];

  for (const componentMatch of currentSource.matchAll(scrollComponentPattern)) {
    const [rawVariantAlias] = componentMatch.slice(1);
    const functionStart = currentSource.lastIndexOf(
      "function ",
      componentMatch.index,
    );
    if (functionStart === -1) {
      continue;
    }
    const functionPrefix = currentSource.slice(
      functionStart,
      componentMatch.index,
    );
    const functionSignature = functionPrefix.match(
      /^function [A-Za-z_$][\w$]*\([^)]*\)\{/u,
    );
    if (functionSignature == null) {
      continue;
    }
    const functionBraceStart =
      functionStart + functionSignature[0].lastIndexOf("{");
    const functionEnd = findMatchingBrace(currentSource, functionBraceStart);
    if (functionEnd === -1 || functionEnd < componentMatch.index) {
      continue;
    }

    const functionSource = currentSource.slice(functionStart, functionEnd + 1);
    if (!functionSource.includes("data-quick-chat-thread-scroll-spacer")) {
      continue;
    }

    const normalizedVariantPattern = new RegExp(
      `(?:^|,)(${identifier})=${escapeRegExp(rawVariantAlias)}===void 0\\?\`floating\`:${escapeRegExp(rawVariantAlias)}`,
      "gu",
    );
    const normalizedVariantMatches = [
      ...functionSource.matchAll(normalizedVariantPattern),
    ];
    if (normalizedVariantMatches.length !== 1) {
      return null;
    }
    const variantAlias = normalizedVariantMatches[0][1];

    const unpatchedSpacerPattern =
      /className:`shrink-0`,"data-quick-chat-thread-scroll-spacer":`true`/gu;
    const fixedSpacerPattern = new RegExp(
      `className:\`shrink-0\`,style:${escapeRegExp(variantAlias)}===\`window\`\\?\\{maxHeight:0\\}:void 0,"data-quick-chat-thread-scroll-spacer":\`true\``,
      "gu",
    );
    const unpatchedMatches = [
      ...functionSource.matchAll(unpatchedSpacerPattern),
    ];
    const zeroCapMatches = [...functionSource.matchAll(fixedSpacerPattern)];
    const legacyCapPattern = new RegExp(
      fixedSpacerPattern.source.replace(
        "maxHeight:0",
        `maxHeight:${quickChatWindowSpacerExtraHeight}`,
      ),
      fixedSpacerPattern.flags,
    );
    const legacyCapMatches = [...functionSource.matchAll(legacyCapPattern)];
    const responsiveCapPattern = new RegExp(
      fixedSpacerPattern.source.replace(
        "maxHeight:0",
        `maxHeight:\`${escapeRegExp(quickChatWindowSpacerMaxHeight)}\``,
      ),
      fixedSpacerPattern.flags,
    );
    const responsiveCapMatches = [
      ...functionSource.matchAll(responsiveCapPattern),
    ];
    if (
      unpatchedMatches.length +
        zeroCapMatches.length +
        legacyCapMatches.length +
        responsiveCapMatches.length !==
      1
    ) {
      return null;
    }

    const editableMatch =
      unpatchedMatches[0] ?? zeroCapMatches[0] ?? legacyCapMatches[0];
    contracts.push({
      edit:
        editableMatch == null
          ? null
          : {
              start: functionStart + editableMatch.index,
              end:
                functionStart + editableMatch.index + editableMatch[0].length,
              replacement:
                "className:`shrink-0`," +
                `style:${variantAlias}===\`window\`?{maxHeight:\`${quickChatWindowSpacerMaxHeight}\`}:void 0,` +
                '"data-quick-chat-thread-scroll-spacer":`true`',
            },
    });
  }

  return contracts.length === 1 ? contracts[0] : null;
}

function applyQuickChatWindowZoomPatch(currentSource) {
  const zoomContractLookbehind = 12_000;
  const quickChatWindowRootPattern =
    /(([A-Za-z_$][\w$]*)===`floating`&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.floatingSurface,`[^`]*`\),)\2===`window`&&`relative h-dvh w-full overflow-hidden bg-token-editor-background\/55`/gu;
  const roots = regexpMatches(currentSource, quickChatWindowRootPrefixPattern);

  if (roots.length > 0) {
    const patchableRoots = new Map(
      [...currentSource.matchAll(quickChatWindowRootPattern)].map((match) => [
        match.index,
        match,
      ]),
    );
    const patchedRootIndexes = new Set(
      [...currentSource.matchAll(patchedQuickChatWindowPattern)].map(
        (match) => match.index,
      ),
    );
    const edits = new Map();
    const spacerContract = findQuickChatWindowSpacerContract(currentSource);
    if (spacerContract == null) {
      console.warn(
        "WARN: Could not find popped-out Quick Chat zoom root insertion point — skipping Quick Chat zoom patch",
      );
      return currentSource;
    }
    if (spacerContract.edit != null) {
      edits.set(spacerContract.edit.start, spacerContract.edit);
    }
    const hasUnknownRoot = roots.some((root) => {
      const patchableRoot = patchableRoots.get(root.index);
      const isPatchedRoot = patchedRootIndexes.has(root.index);
      if (patchableRoot == null && !isPatchedRoot) {
        return true;
      }

      const [, , , stylesAlias] = root;
      const regionStart = Math.max(0, root.index - zoomContractLookbehind);
      const quickChatPrefix = currentSource.slice(regionStart, root.index);
      const bindingPattern = new RegExp(
        `(?:^|[^A-Za-z0-9_$])${escapeRegExp(stylesAlias)}=\\{`,
        "gu",
      );
      let bindingMatch = null;
      for (const match of quickChatPrefix.matchAll(bindingPattern)) {
        bindingMatch = match;
      }
      if (bindingMatch == null) {
        return true;
      }

      const bindingStart = bindingMatch.index + bindingMatch[0].length - 1;
      const bindingEnd = findMatchingBrace(quickChatPrefix, bindingStart);
      if (bindingEnd === -1) {
        return true;
      }

      const stylesBinding = quickChatPrefix.slice(bindingStart, bindingEnd + 1);
      if (!(
        stylesBinding.includes("zoomedViewport:") &&
        stylesBinding.includes("floatingSurface:")
      )) {
        return true;
      }

      const functionStart = currentSource.lastIndexOf("function ", root.index);
      if (functionStart === -1) {
        return true;
      }
      const functionPrefix = currentSource.slice(functionStart, root.index);
      const functionSignature = functionPrefix.match(
        /^function [A-Za-z_$][\w$]*\([^)]*\)\{/u,
      );
      if (functionSignature == null) {
        return true;
      }
      const functionBraceStart =
        functionStart + functionSignature[0].lastIndexOf("{");
      const functionEnd = findMatchingBrace(currentSource, functionBraceStart);
      if (functionEnd === -1 || functionEnd < root.index) {
        return true;
      }

      const [variantAlias] = root.slice(1);
      const assignmentPrefix = "(?:let\\s+|,)";
      const identifier = "[A-Za-z_$][\\w$]*";
      const functionSource = currentSource.slice(
        functionStart,
        functionEnd + 1,
      );
      const scrollRenderPattern = new RegExp(
        `initialScrollMode:${identifier},isWindowZoomApplied:(${identifier}),scrollOrigin:(${identifier}),variant:${escapeRegExp(variantAlias)}`,
        "gu",
      );
      const scrollRenderMatches = [
        ...functionSource.matchAll(scrollRenderPattern),
      ];
      if (scrollRenderMatches.length !== 1) {
        return true;
      }
      const [, zoomAppliedAlias, scrollOriginAlias] = scrollRenderMatches[0];
      const unpatchedScrollPattern = new RegExp(
        `(${assignmentPrefix})${escapeRegExp(zoomAppliedAlias)}=${escapeRegExp(variantAlias)}===\`floating\`,${escapeRegExp(scrollOriginAlias)}=`,
        "gu",
      );
      const patchedScrollPattern = new RegExp(
        `(${assignmentPrefix})${escapeRegExp(zoomAppliedAlias)}=${escapeRegExp(variantAlias)}===\`floating\`\\|\\|${escapeRegExp(variantAlias)}===\`window\`,${escapeRegExp(scrollOriginAlias)}=`,
        "gu",
      );
      const unpatchedScrollMatches = [
        ...functionSource.matchAll(unpatchedScrollPattern),
      ];
      const patchedScrollMatches = [
        ...functionSource.matchAll(patchedScrollPattern),
      ];
      if (unpatchedScrollMatches.length + patchedScrollMatches.length !== 1) {
        return true;
      }

      if (unpatchedScrollMatches.length === 1) {
        const scrollMatch = unpatchedScrollMatches[0];
        const scrollStart = functionStart + scrollMatch.index;
        edits.set(scrollStart, {
          start: scrollStart,
          end: scrollStart + scrollMatch[0].length,
          replacement:
            `${scrollMatch[1]}${zoomAppliedAlias}=${variantAlias}===\`floating\`||` +
            `${variantAlias}===\`window\`,${scrollOriginAlias}=`,
        });
      }

      if (patchableRoot != null) {
        const [
          ,
          floatingRoot,
          rootVariantAlias,
          classNamesAlias,
          rootStylesAlias,
        ] = patchableRoot;
        edits.set(patchableRoot.index, {
          start: patchableRoot.index,
          end: patchableRoot.index + patchableRoot[0].length,
          replacement:
            `${floatingRoot}${rootVariantAlias}===\`window\`&&` +
            `${classNamesAlias}(${rootStylesAlias}.zoomedViewport,` +
            "`relative overflow-hidden bg-token-editor-background/55`)",
        });
      }

      return false;
    });

    if (hasUnknownRoot) {
      console.warn(
        "WARN: Could not find popped-out Quick Chat zoom root insertion point — skipping Quick Chat zoom patch",
      );
      return currentSource;
    }

    if (edits.size === 0) {
      return currentSource;
    }

    let patchedSource = currentSource;
    for (const edit of [...edits.values()].sort(
      (left, right) => right.start - left.start,
    )) {
      patchedSource =
        patchedSource.slice(0, edit.start) +
        edit.replacement +
        patchedSource.slice(edit.end);
    }
    return patchedSource;
  }

  if (
    currentSource.includes(".floatingSurface") &&
    currentSource.includes(
      "relative h-dvh w-full overflow-hidden bg-token-editor-background/55",
    )
  ) {
    console.warn(
      "WARN: Could not find popped-out Quick Chat zoom root insertion point — skipping Quick Chat zoom patch",
    );
  }

  return currentSource;
}

function hasQuickChatWindowZoomPostconditions(source) {
  if (!isQuickChatWindowZoomTarget(source)) {
    return false;
  }

  const roots = regexpMatches(source, quickChatWindowRootPrefixPattern);
  const patchedRoots = regexpMatches(source, patchedQuickChatWindowPattern);
  const patchedScrollContracts = regexpMatches(
    source,
    patchedQuickChatWindowScrollPattern,
  );
  const spacerContract = findQuickChatWindowSpacerContract(source);

  return (
    roots.length > 0 &&
    patchedRoots.length === roots.length &&
    patchedScrollContracts.length > 0 &&
    spacerContract != null &&
    spacerContract.edit == null
  );
}

function quickChatWindowZoomAssetCandidates(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return { assetsDir, matches: [] };
  }

  const matches = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => {
      const filePath = path.join(assetsDir, name);
      return { filePath, name, source: fs.readFileSync(filePath, "utf8") };
    })
    .filter(({ source }) => isQuickChatWindowZoomTarget(source));
  return { assetsDir, matches };
}

function patchQuickChatWindowZoomAssets(extractedDir) {
  const { assetsDir, matches } =
    quickChatWindowZoomAssetCandidates(extractedDir);
  if (matches.length !== 1) {
    const reason =
      matches.length === 0
        ? `Could not find the semantic Quick Chat window bundle in ${assetsDir}`
        : `Found ${matches.length} semantic Quick Chat window bundles in ${assetsDir}; expected exactly one`;
    console.warn(`WARN: ${reason} — skipping Quick Chat zoom patch`);
    return { matched: matches.length, changed: false, verified: false, reason };
  }

  const [{ filePath, name, source }] = matches;
  if (hasQuickChatWindowZoomPostconditions(source)) {
    return { matched: 1, changed: false, verified: true, assetName: name };
  }

  const patchedSource = applyQuickChatWindowZoomPatch(source);
  if (
    patchedSource === source ||
    !hasQuickChatWindowZoomPostconditions(patchedSource)
  ) {
    const reason = `Quick Chat zoom postconditions failed for ${name}`;
    console.warn(`WARN: ${reason} — leaving the asset unchanged`);
    return { matched: 1, changed: false, verified: false, reason };
  }

  fs.writeFileSync(filePath, patchedSource, "utf8");
  return { matched: 1, changed: true, verified: true, assetName: name };
}

module.exports = {
  descriptors: [
    {
      id: "quick-chat-window-zoom",
      phase: "extracted-app:post-webview",
      order: 20_740,
      ciPolicy: "optional",
      apply: patchQuickChatWindowZoomAssets,
      status: (result, warnings) => ({
        status: result?.changed
          ? "applied"
          : result?.verified && result?.matched === 1 && warnings.length === 0
            ? "already-applied"
            : "skipped-optional",
        reason: result?.reason ?? warnings[0] ?? null,
      }),
    },
  ],
  applyQuickChatWindowZoomPatch,
  hasQuickChatWindowZoomPostconditions,
  isQuickChatWindowZoomTarget,
  patchQuickChatWindowZoomAssets,
  quickChatWindowSpacerExtraHeight,
  quickChatWindowSpacerMaxHeight,
};
