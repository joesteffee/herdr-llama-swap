import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("src/cli.js");

// Fake herdr: logs args; $LIST is the workspace-list JSON; $FAIL makes everything exit 1.
function fake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeherdr-"));
  const bin = path.join(dir, "herdr");
  const log = path.join(dir, "log");
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${log}"
if [ -n "$FAIL" ]; then echo boom >&2; exit 1; fi
case "$1 $2" in
  "workspace list") echo "$LIST";;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"w5:p1"},"workspace":{"workspace_id":"w5","label":"llama-swap"}}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"w1:p2"}}}';;
esac
exit 0
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const open = (args, extra = {}) => {
    const r = spawnSync("node", [CLI, "open", ...args], { encoding: "utf8", env: { ...process.env, HERDR_BIN_PATH: bin, HERDR_PLUGIN_ROOT: "/plug", LIST: '{"result":{"workspaces":[]}}', ...extra } });
    return { ...r, calls: calls() };
  };
  return { open };
}

test("workspace: creates when none exists", () => {
  const r = fake().open([]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "w5");
  assert.match(r.calls[1], /^workspace create --cwd \/plug --label llama-swap --no-focus$/);
  assert.match(r.calls[2], /^pane run w5:p1 cd '\/plug' && node '\/plug\/src\/cli.js' dashboard$/);
});

test("workspace: reuses existing labelled workspace, no duplicate", () => {
  const list = '{"result":{"workspaces":[{"workspace_id":"w7","label":"llama-swap","tokens":{"model":"x"}}]}}';
  const r = fake().open(["--target", "workspace"], { LIST: list });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "w7");
  assert.ok(r.calls.some((c) => c === "workspace focus w7"));
  assert.ok(!r.calls.some((c) => c.startsWith("workspace create")));
});

test("workspace: existing with empty tokens gets dashboard run", () => {
  const list = '{"result":{"workspaces":[{"workspace_id":"w7","label":"llama-swap","root_pane":{"pane_id":"w7:p1"}}]}}';
  const r = fake().open([], { LIST: list });
  assert.equal(r.status, 0);
  assert.ok(r.calls.some((c) => c.startsWith("pane run w7:p1 ")));
});

test("split mode", () => {
  const r = fake().open(["--target", "split", "--json"]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).id, "w1:p2");
  assert.equal(r.calls[0], "pane split --current --direction right");
  assert.match(r.calls[1], /^pane run w1:p2 /);
});

test("popup mode delegates to plugin pane open", () => {
  const r = fake().open(["--target", "popup"]);
  assert.equal(r.status, 0);
  assert.equal(r.calls[0], "plugin pane open --plugin llama-swap --entrypoint dashboard --focus");
});

test("herdr failing -> exit 1 with reason", () => {
  const r = fake().open([], { FAIL: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boom/);
});

test("herdr missing -> exit 1, no throw", () => {
  const r = fake().open([], { HERDR_BIN_PATH: "/nonexistent/herdr" });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.trim().length > 0);
});

test("bad target -> exit 2", () => {
  assert.equal(fake().open(["--target", "nope"]).status, 2);
});
