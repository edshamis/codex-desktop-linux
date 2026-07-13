#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../../scripts/lib/linux-features.js");
const { applyQuickChatWindowZoomPatch } = require("./patch.js");

const warning =
  "WARN: Could not find popped-out Quick Chat zoom root insertion point — skipping Quick Chat zoom patch";

function applyPatchTwice(source) {
  const patched = applyQuickChatWindowZoomPatch(source);
  assert.equal(applyQuickChatWindowZoomPatch(patched), patched);
  return patched;
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function unpatchedRoot(variant = "c", classNames = "vC", styles = "c0") {
  return `${variant}===\`floating\`&&${classNames}(${styles}.floatingSurface,\`fixed\`),${variant}===\`window\`&&\`relative h-dvh w-full overflow-hidden bg-token-editor-background/55\``;
}

function patchedRoot(variant = "c", classNames = "vC", styles = "c0") {
  return `${variant}===\`floating\`&&${classNames}(${styles}.floatingSurface,\`fixed\`),${variant}===\`window\`&&${classNames}(${styles}.zoomedViewport,\`relative overflow-hidden bg-token-editor-background/55\`)`;
}

function unpatchedScrollContract(variant = "c", flag = "z", next = "p") {
  return `let ${flag}=${variant}===\`floating\`,${next}=0`;
}

function patchedScrollContract(variant = "c", flag = "z", next = "p") {
  return `let ${flag}=${variant}===\`floating\`||${variant}===\`window\`,${next}=0`;
}

function quickChatComponent({
  roots = [`root=${unpatchedRoot()}`],
  scrollContracts = ["let lt=c===`floating`,ut=0", unpatchedScrollContract()],
  styleBindings = ["c0={zoomedViewport:a0,floatingSurface:o0}"],
} = {}) {
  return `function quickChat(c){${[
    ...styleBindings,
    ...roots,
    ...scrollContracts,
    "return n0({initialScrollMode:m,isWindowZoomApplied:z,scrollOrigin:p,variant:c})",
  ].join(";")}}`;
}

test("local feature stays disabled until explicitly enabled", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "quick-chat-window-zoom-"),
  );
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    const featureDir = path.join(
      featuresRoot,
      "local",
      "quick-chat-window-zoom",
    );
    fs.mkdirSync(featureDir, { recursive: true });
    for (const name of ["feature.json", "README.md", "patch.js"]) {
      fs.copyFileSync(path.join(__dirname, name), path.join(featureDir, name));
    }
    const helperDir = path.join(tempDir, "scripts", "patches", "lib");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../../../scripts/patches/lib/minified-js.js"),
      path.join(helperDir, "minified-js.js"),
    );
    fs.writeFileSync(
      path.join(featuresRoot, "features.example.json"),
      '{"enabled":[]}\n',
    );

    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(
      path.join(featuresRoot, "features.json"),
      '{"enabled":["quick-chat-window-zoom"]}\n',
    );
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.id),
      ["feature:quick-chat-window-zoom:quick-chat-window-zoom"],
    );
    assert.match("app-initial~app-main~page-abc.js", descriptors[0].pattern);
    assert.doesNotMatch("app-main-abc.js", descriptors[0].pattern);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applies zoom and zoom-aware scrolling to a popped-out Quick Chat viewport", () => {
  const source = quickChatComponent();
  const patched = applyPatchTwice(source);
  assert.match(patched, /c===`window`&&vC\(c0\.zoomedViewport/);
  assert.match(patched, /let z=c===`floating`\|\|c===`window`,p=0/);
  assert.match(patched, /let lt=c===`floating`,ut=0/);
  assert.doesNotMatch(patched, /c===`window`&&`relative h-dvh w-full/);
});

test("patches every verified Quick Chat root", () => {
  const source = quickChatComponent({
    roots: [`first=${unpatchedRoot()}`, `second=${unpatchedRoot()}`],
  });
  const patched = applyPatchTwice(source);
  assert.equal(
    (patched.match(/c===`window`&&vC\(c0\.zoomedViewport/g) ?? []).length,
    2,
  );
});

test("patches an unpatched root beside an already patched root", () => {
  const source = quickChatComponent({
    roots: [`first=${patchedRoot()}`, `second=${unpatchedRoot()}`],
  });
  const patched = applyPatchTwice(source);
  assert.equal(
    (patched.match(/c===`window`&&vC\(c0\.zoomedViewport/g) ?? []).length,
    2,
  );
});

test("does not mistake an unrelated zoomed viewport for Quick Chat", () => {
  const source =
    "unrelated=x===`window`&&classes(s0.zoomedViewport,`relative overflow-hidden bg-token-editor-background/55`);" +
    quickChatComponent({ roots: [`quick=${unpatchedRoot()}`] });
  const patched = applyPatchTwice(source);
  assert.match(
    patched,
    /quick=c===`floating`[^;]+c===`window`&&vC\(c0\.zoomedViewport/,
  );
});

test("rejects a missing style contract", () => {
  const source = quickChatComponent({
    roots: [`quick=${unpatchedRoot()}`],
    styleBindings: ["unrelated=vC(c0.zoomedViewport,`relative`)"],
  });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("does not bind a style identifier suffix", () => {
  const source = quickChatComponent({
    roots: [`quick=${unpatchedRoot("c", "vC", "a")}`],
    styleBindings: ["ba={zoomedViewport:a0,floatingSurface:o0}"],
  });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("rejects a style contract outside the bounded lookbehind", () => {
  const source = quickChatComponent({
    roots: [`quick=${unpatchedRoot()}`],
    styleBindings: [
      `c0={zoomedViewport:a0,floatingSurface:o0}${";".repeat(12_001)}`,
    ],
  });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("validates the style contract for already patched roots", () => {
  const source = quickChatComponent({
    roots: [`quick=${patchedRoot()}`],
    scrollContracts: [patchedScrollContract()],
    styleBindings: [
      `c0={zoomedViewport:a0,floatingSurface:o0}${";".repeat(12_001)}`,
    ],
  });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("leaves every root unchanged when one root contract is missing", () => {
  const source = quickChatComponent({
    roots: [
      `first=${unpatchedRoot()}`,
      `second=${unpatchedRoot("d", "wC", "d0")}`,
    ],
    scrollContracts: [
      unpatchedScrollContract(),
      unpatchedScrollContract("d", "y", "q"),
    ],
  });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("leaves every root unchanged when one root has drifted", () => {
  const source = quickChatComponent({
    roots: [
      `first=${unpatchedRoot()}`,
      "second=d===`floating`&&wC(d0.floatingSurface,`fixed`),d===`window`&&wC(d0.zoomedViewport,`drifted-window-root`)",
    ],
    scrollContracts: [
      unpatchedScrollContract(),
      unpatchedScrollContract("d", "y", "q"),
    ],
    styleBindings: [
      "c0={zoomedViewport:a0,floatingSurface:o0}",
      "d0={zoomedViewport:b0,floatingSurface:p0}",
    ],
  });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("rejects a zoomed root without the matching scroll-coordinate contract", () => {
  const source = quickChatComponent({ scrollContracts: [] });
  assert.deepEqual(
    captureWarnings(() =>
      assert.equal(applyQuickChatWindowZoomPatch(source), source),
    ),
    [warning],
  );
});

test("warns on a recognizable but drifted Quick Chat root", () => {
  const source =
    "st=classes(`base`,c===`floating`?classes(c0.floatingSurface,`fixed`):c===`window`?`relative h-dvh w-full overflow-hidden bg-token-editor-background/55`:null)";
  assert.deepEqual(
    captureWarnings(() => applyQuickChatWindowZoomPatch(source)),
    [warning],
  );
});
