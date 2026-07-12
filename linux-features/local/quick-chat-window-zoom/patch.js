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
    const hasUnknownRoot = roots.some((root) => {
      const patchableRoot = patchableRoots.get(root.index);
      if (patchableRoot == null && !patchedRootIndexes.has(root.index)) {
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
      return !(
        stylesBinding.includes("zoomedViewport:") &&
        stylesBinding.includes("floatingSurface:")
      );
    });

    if (hasUnknownRoot) {
      console.warn(
        "WARN: Could not find popped-out Quick Chat zoom root insertion point — skipping Quick Chat zoom patch",
      );
      return currentSource;
    }

    if (patchableRoots.size === 0) {
      return currentSource;
    }

    return currentSource.replace(
      quickChatWindowRootPattern,
      (_match, floatingRoot, variantAlias, classNamesAlias, stylesAlias) =>
        `${floatingRoot}${variantAlias}===\`window\`&&${classNamesAlias}(${stylesAlias}.zoomedViewport,\`relative overflow-hidden bg-token-editor-background/55\`)`,
    );
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
