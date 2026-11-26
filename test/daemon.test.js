import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMock } from "./helpers/mock-server.js";
import { computeEvents, pollOnce, backoffMs } from "../src/daemon.js";
import { LlamaSwapClient } from "../src/lib/client.js";
import * as herdr from "../src/lib/herdr.js";
import { collect } from "../src/lib/poll.js";
import { render, stripAnsi } from "../src/dashboard.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (args, env) =>
  new Promise((resolve) => execFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

let mock, tmp;
before(async () => {
  mock = await startMock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsw-"));
});
after(async () => {
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("daemon once writes state.json", async () => {
  const env = { LLAMASWAP_URL: mock.url, HERDR_PLUGIN_STATE_DIR: tmp, HERDR_BIN_PATH: "/nonexistent", HERDR_WORKSPACE_ID: "" };
  const r = await run(["src/daemon.js", "once"], env);
  assert.equal(r.code, 0, r.stderr);
  const printed = JSON.parse(r.stdout);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"));
  assert.equal(onDisk.status, "online");
  assert.equal(onDisk.loaded, "inkling-2-mini");
  assert.equal(onDisk.updatedAt, printed.updatedAt);
});

test("pollOnce survives an unreachable server and records offline", async () => {
  const paths = { state: path.join(tmp, "off", "state.json") };
  const client = new LlamaSwapClient("http://127.0.0.1:1", { timeoutMs: 300 });
  const s = await pollOnce({ client, paths, env: { HERDR_BIN_PATH: "/nonexistent" }, nowMs: 5 });
  assert.equal(s.status, "offline");
  assert.match(s.lastError, /failed/);
  assert.equal(JSON.parse(fs.readFileSync(paths.state, "utf8")).status, "offline");
});

test("computeEvents fires only on transitions", () => {
  const on = (loaded, extra = {}) => ({ status: "online", loaded, lastError: null, ...extra });
  const off = { status: "offline", loaded: null, lastError: "down" };
  assert.deepEqual(computeEvents(null, on("a")), []);
  assert.deepEqual(computeEvents(on("a"), on("a")), []);
  assert.match(computeEvents(on("a"), on("b"))[0].body, /a -> b/);
  assert.match(computeEvents(on("a"), off)[0].title, /offline/);
  assert.match(computeEvents(off, on("a"))[0].title, /back online/);
  assert.match(computeEvents(on("a"), on(null))[0].title, /unloaded/);
  assert.match(computeEvents(on("a"), on("a", { lastError: "slots failed" }))[0].title, /error/);
});

test("backoff grows after 3 failures and caps at 30s", () => {
  assert.equal(backoffMs(2000, 0), 2000);
  assert.equal(backoffMs(2000, 3), 4000);
  assert.equal(backoffMs(2000, 20), 30000);
});

test("herdr.js never throws when the binary is missing", async () => {
  const env = { HERDR_BIN_PATH: "/nonexistent" };
  const n = await herdr.notify("t", "b", { env });
  assert.equal(n.ok, false);
  const r = await herdr.reportTokens({ loaded: "m", phase: "idle", rates: {}, gpu: null }, { env, workspaceId: "w1" });
  assert.equal(r.ok, false);
  assert.equal(await herdr.resolveWorkspaceId({ env }), null);
  assert.equal(await herdr.resolveWorkspaceId({ env: { HERDR_WORKSPACE_ID: "ws9" } }), "ws9");
});

test("herdr workspace parsing handles bare and enveloped JSON", () => {
  const list = [{ id: "a" }, { id: "b", focused: true }];
  assert.equal(herdr.pickFocusedWorkspace(herdr.unwrap(JSON.stringify({ result: { workspaces: list } }))), "b");
  assert.equal(herdr.pickFocusedWorkspace(herdr.unwrap(JSON.stringify(list))), "b");
  assert.equal(herdr.pickFocusedWorkspace(null), null);
});

test("token formatting includes model, phase, tps, vram", () => {
  const { tokens, ttlMs } = herdr.formatTokens({ loaded: "m", phase: "decode", status: "online", rates: { decodeTps: 7.74 }, gpu: { vramUsedBytes: 2 * 1024 ** 3, vramTotalBytes: 8 * 1024 ** 3 } }, 2000);
  assert.deepEqual(tokens, { model: "m", phase: "decode", tps: "7.7", vram: "2.0/8.0 GiB" });
  assert.equal(ttlMs, 8000);
});

test("CLI unload guard refuses an unloaded model and never POSTs", async () => {
  mock.posts.length = 0;
  const r = await run(["src/cli.js", "unload", "flash-next", "--yes", "--url", mock.url], {});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not currently loaded/);
  assert.equal(mock.posts.length, 0);
});

test("CLI unload without --yes and no TTY is refused; with --yes POSTs", async () => {
  mock.posts.length = 0;
  const r1 = await run(["src/cli.js", "unload", "inkling-2-mini", "--url", mock.url], {});
  assert.equal(r1.code, 1);
  assert.equal(mock.posts.length, 0);
  const r2 = await run(["src/cli.js", "unload", "inkling-2-mini", "--yes", "--url", mock.url], {});
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(mock.posts[0].path, "/api/models/unload/inkling-2-mini");
});

test("CLI usage errors exit 2; --version works; status --json parses", async () => {
  assert.equal((await run(["src/cli.js", "bogus"], {})).code, 2);
  assert.match((await run(["src/cli.js", "--version"], {})).stdout, /^0\.1\.0/);
  const r = await run(["src/cli.js", "status", "--json", "--url", mock.url], {});
  assert.equal(JSON.parse(r.stdout).loaded, "inkling-2-mini");
});

test("dashboard render snapshot has key fields and actions text", async () => {
  const state = await collect(new LlamaSwapClient(mock.url));
  const text = stripAnsi(render(state, { url: mock.url, color: false }).join("\n"));
  assert.match(text, /\[ONLINE\]/);
  assert.match(text, /inkling-2-mini/);
  assert.match(text, /1000\/131072/);
  assert.match(text, /6\.6\/8\.0 GiB/);
  const off = stripAnsi(render({ status: "offline", lastError: "x" }, { color: false }).join("\n"));
  assert.match(off, /unreachable/);
});

test("daemon run keeps polling (regression: unref sleep ended the loop)", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "loop-"));
  const env = { LLAMASWAP_URL: mock.url, LLAMASWAP_POLL_MS: "250", HERDR_PLUGIN_STATE_DIR: dir, HERDR_BIN_PATH: "/nonexistent", HERDR_WORKSPACE_ID: "w1" };
  const child = spawn(process.execPath, ["src/daemon.js", "run"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "ignore" });
  const read = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")); } catch { return null; } };
  try {
    let first = null;
    for (let i = 0; i < 60 && !first; i++) { await new Promise((r) => setTimeout(r, 100)); first = read(); }
    assert.ok(first, "daemon wrote state.json");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(child.exitCode, null, "daemon must still be alive after its first poll");
    const second = read();
    assert.ok(second && second.updatedAt > first.updatedAt, "daemon must keep polling and rewriting state.json");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});
