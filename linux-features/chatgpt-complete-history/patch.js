"use strict";

const fs = require("node:fs");
const path = require("node:path");

const identifier = "[A-Za-z_$][\\w$]*";
const historyPatchMarker = "/*codex-linux-chatgpt-complete-history*/";
const historyWarning =
  "WARN: Could not verify current ChatGPT complete-history contracts - skipping complete history feature patch";

const tppTargetFilterPattern = new RegExp(
  `if\\((${identifier})\\.kind!==\`optimistic\`&&\\1\\.conversation\\.conversation_origin===\`tpp\`\\)return\\[\\];`,
  "gu",
);
const patchedTppTargetFilterPattern = new RegExp(
  `${escapeRegExp(historyPatchMarker)}if\\(!1&&(${identifier})\\.kind!==\`optimistic\`&&\\1\\.conversation\\.conversation_origin===\`tpp\`\\)return\\[\\];`,
  "gu",
);
const nativeHistoryMergePattern = new RegExp(
  `\\.\\.\\.\\(${identifier}\\.data\\?\\.pages\\?\\?\\[\\]\\)\\.flatMap\\(${identifier}\\),` +
    `\\.\\.\\.\\(${identifier}\\.data\\?\\.pages\\?\\?\\[\\]\\)\\.flatMap\\(${identifier}\\)`,
  "u",
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function hasNativeCompleteHistoryFeed(source) {
  return (
    source.includes("flatConversationHistory") &&
    source.includes("excludeConversationOrigin:`tpp`") &&
    source.includes("conversationOrigin:`tpp`") &&
    source.includes("isConversationError:") &&
    source.includes("isConversationLoading:") &&
    nativeHistoryMergePattern.test(source)
  );
}

function patchQuickChatHistorySource(source) {
  const raw = matches(source, tppTargetFilterPattern);
  const patched = matches(source, patchedTppTargetFilterPattern);
  if (raw.length === 0 && patched.length === 1) {
    return { source, matched: 1, changed: 0, reason: null };
  }
  if (raw.length !== 1 || patched.length !== 0) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `Found ${raw.length} unpatched and ${patched.length} patched Quick Chat TPP filters`,
    };
  }

  const match = raw[0];
  return {
    source:
      source.slice(0, match.index) +
      historyPatchMarker +
      match[0].replace("if(", "if(!1&&") +
      source.slice(match.index + match[0].length),
    matched: 1,
    changed: 1,
    reason: null,
  };
}

function webviewJavaScriptAssetNames(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return { assetsDir, names: [] };
  }
  return {
    assetsDir,
    names: fs
      .readdirSync(assetsDir)
      .filter((name) => name.endsWith(".js"))
      .sort(),
  };
}

function discoverCompleteHistoryContracts(extractedDir) {
  const { assetsDir, names } = webviewJavaScriptAssetNames(extractedDir);
  if (names.length === 0) {
    return {
      verified: false,
      reason: `No JavaScript webview assets found in ${assetsDir}`,
    };
  }

  const quickChatCandidates = [];
  const nativeHistoryCandidates = [];
  for (const name of names) {
    const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
    const result = patchQuickChatHistorySource(source);
    if (result.matched === 1) {
      quickChatCandidates.push({ name, source, result });
    }
    if (hasNativeCompleteHistoryFeed(source)) {
      nativeHistoryCandidates.push({ name });
    }
  }

  if (quickChatCandidates.length !== 1) {
    return {
      verified: false,
      reason: `Found ${quickChatCandidates.length} Quick Chat TPP filter contracts`,
    };
  }
  if (nativeHistoryCandidates.length !== 1) {
    return {
      verified: false,
      reason: `Found ${nativeHistoryCandidates.length} native complete-history feed contracts`,
    };
  }

  return {
    verified: true,
    reason: null,
    assetsDir,
    quickChat: quickChatCandidates[0],
    nativeHistory: nativeHistoryCandidates[0],
  };
}

function patchCompleteHistory(extractedDir) {
  const discovery = discoverCompleteHistoryContracts(extractedDir);
  if (!discovery.verified) {
    console.warn(`${historyWarning}: ${discovery.reason}`);
    return {
      matched: 0,
      changed: 0,
      verified: false,
      reason: discovery.reason,
    };
  }

  const { quickChat, nativeHistory, assetsDir } = discovery;
  if (quickChat.result.changed === 1) {
    fs.writeFileSync(
      path.join(assetsDir, quickChat.name),
      quickChat.result.source,
      "utf8",
    );
  }
  return {
    matched: 2,
    changed: quickChat.result.changed,
    verified: true,
    reason: null,
    targets: {
      quickChat: quickChat.name,
      nativeHistory: nativeHistory.name,
    },
  };
}

const descriptors = [
  {
    id: "complete-history",
    phase: "extracted-app:post-webview",
    order: 20_750,
    ciPolicy: "optional",
    apply: patchCompleteHistory,
    status: (result, warnings) => {
      if (result?.verified !== true) {
        return {
          status: "skipped-optional",
          reason: result?.reason ?? warnings[0] ?? null,
        };
      }
      return result.changed === 1 ? "applied" : "already-applied";
    },
  },
];

module.exports = {
  descriptors,
  discoverCompleteHistoryContracts,
  hasNativeCompleteHistoryFeed,
  historyPatchMarker,
  historyWarning,
  patchCompleteHistory,
  patchQuickChatHistorySource,
};
