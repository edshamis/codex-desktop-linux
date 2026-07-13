"use strict";

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../../scripts/patches/lib/minified-js.js");

function applyQuickChatWindowZoomPatch(currentSource) {
  const zoomContractLookbehind = 12_000;
  const quickChatWindowRootPrefixPattern =
    /([A-Za-z_$][\w$]*)===`floating`&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.floatingSurface,`[^`]*`\),\1===`window`&&/gu;
  const quickChatWindowRootPattern =
    /(([A-Za-z_$][\w$]*)===`floating`&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.floatingSurface,`[^`]*`\),)\2===`window`&&`relative h-dvh w-full overflow-hidden bg-token-editor-background\/55`/gu;
  const patchedQuickChatWindowPattern =
    /([A-Za-z_$][\w$]*)===`floating`&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.floatingSurface,`[^`]*`\),\1===`window`&&\2\(\3\.zoomedViewport,`relative overflow-hidden bg-token-editor-background\/55`\)/gu;
  const roots = [...currentSource.matchAll(quickChatWindowRootPrefixPattern)];

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

module.exports = {
  descriptors: [
    {
      id: "quick-chat-window-zoom",
      phase: "webview-asset",
      order: 20_740,
      ciPolicy: "optional",
      pattern: /^app-initial~app-main~page-.*\.js$/,
      missingDescription: "shared Quick Chat component bundle",
      skipDescription: "popped-out Quick Chat zoom root patch",
      apply: applyQuickChatWindowZoomPatch,
    },
  ],
  applyQuickChatWindowZoomPatch,
};
