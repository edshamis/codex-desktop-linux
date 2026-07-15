#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  applySharedAppServerSocketPatch,
  descriptors,
} = require("./patch.js");

const socketEnvHook = path.join(__dirname, "socket-env.sh");

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function waitForSocket(socketPath, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`app-server exited before creating its socket (${child.exitCode})`);
    }
    try {
      if (fs.statSync(socketPath).isSocket()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the app-server socket");
}

async function readWebSocketUpgrade(child) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket upgrade")),
      5000,
    );
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks).toString("utf8");
      if (response.includes("\r\n\r\n")) finish(null, response);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
  });
}

async function stopChild(child) {
  if (child == null || child.exitCode != null || child.signalCode != null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await closed;
}

function syntheticBundle() {
  return [
    "var Ky=class{kind=`websocket`;proxyStreams=new Set;supportsReconnect(){return!0}",
    "async connect(){let t={current:null},r=new n.zn(Fy,{perMessageDeflate:!1,createConnection:()=>",
    "(t.current=this.createSshProxyStream(),t.current)});return n.Ln(r,{onPongTimeout:()=>r.terminate()}),new n.Rn(r)}};",
    "function n6(e){let t=Jy(e.hostConfig);if(t)return Z.info(`selected app-server transport`),new Ky(t);",
    "if(e.transportKind===`remote-control`)return new Remote(e);",
    "if(n.io(e.hostConfig))return new Wsl(e);",
    "let r=r6(e.hostConfig);return r?new n.Fn({websocketUrl:r}):new n.Nn(e)}function afterFactory(){}",
  ].join("");
}

test("shared-app-server-socket stays disabled until explicitly enabled", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((entry) => entry.id),
      ["feature:shared-app-server-socket:main-process-shared-app-server-socket"],
    );
  });
});

test("feature stages only the socket environment hook", () => {
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, path.basename(hook.target), hook.mode.toString(8)]),
        [["launcher", "shared-app-server-socket-socket-env.sh", "755"]],
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("patch selects the bridge only for the local host and is idempotent", () => {
  const source = syntheticBundle();
  const patched = applySharedAppServerSocketPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applySharedAppServerSocketPatch(patched), patched);
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/);
  assert.match(patched, /hostConfig\.kind===`local`/);
  assert.match(patched, /app-server`,\s*`proxy`,\s*`--sock`/);
  assert.match(patched, /app-server`,\s*`--listen`,\s*`unix:\/\//);
  assert.match(patched, /await this\.ensureAuthority\(\)/);
  assert.match(patched, /this\.authority\?\.kill\(\)/);
  assert.match(patched, /requires CODEX_CLI_PATH/);
  assert.match(patched, /new n\.zn\(Fy,/);
  assert.match(patched, /new n\.Rn\(/);
  assert.match(patched, /supportsReconnect\(\)\{return!0\}/);
});

test("patch leaves unsupported bundle shapes unchanged with a warning", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch("unrelated bundle"), "unrelated bundle");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /shared app-server socket/i);
});

test("descriptor is optional and targets the main bundle", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["main-process-shared-app-server-socket", "main-bundle", "optional"]],
  );
});

test("socket hook exports an instance-scoped path without starting a process", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-runtime-"));
  const env = {
    ...process.env,
    CODEX_LINUX_APP_ID: "codex-bridge-test",
    CODEX_LINUX_APP_STATE_DIR: path.join(tempDir, "state"),
    XDG_RUNTIME_DIR: tempDir,
  };
  try {
    const result = spawnSync(socketEnvHook, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${tempDir}/codex-bridge-test/app-server-bridge/app-server.sock`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("socket environment hook shell syntax is valid", () => {
  const result = spawnSync("bash", ["-n", socketEnvHook], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("stock Codex authority and proxy share a private Unix socket", { timeout: 15000 }, async (t) => {
  const codexCli = process.env.CODEX_CLI_PATH;
  if (codexCli == null) {
    t.skip("set CODEX_CLI_PATH to run the real Codex app-server integration test");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-integration-"));
  const codexHome = path.join(tempDir, "codex-home");
  const socketPath = path.join(tempDir, "authority", "app-server.sock");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.mkdirSync(path.dirname(socketPath), { mode: 0o700 });
  const env = { ...process.env, CODEX_HOME: codexHome };
  const authority = spawn(codexCli, ["app-server", "--listen", `unix://${socketPath}`], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let proxy;

  try {
    await waitForSocket(socketPath, authority);
    assert.equal(
      fs.statSync(socketPath).mode & 0o077,
      0,
      "app-server socket must not grant group/other access",
    );

    proxy = spawn(codexCli, ["app-server", "proxy", "--sock", socketPath], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const responsePromise = readWebSocketUpgrade(proxy);
    proxy.stdin.end(
      [
        "GET /rpc HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const response = await responsePromise;
    assert.match(response, /^HTTP\/1\.1 101 /);
    assert.match(response.toLowerCase(), /upgrade: websocket/);
  } finally {
    await Promise.all([stopChild(proxy), stopChild(authority)]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
