import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("src/cli.js");

const DEFAULT_PANES = '{"result":{"panes":[{"pane_id":"w1:p1","workspace_id":"w1","focused":true}]}}';
const SHELL_PROC = '{"result":{"process_info":{"pane_id":"w5:p1","foreground_processes":[{"argv":["/usr/bin/zsh"],"cmdline":"/usr/bin/zsh","name":"zsh","pid":1}]},"type":"pane_process_info"}}';
const DASH_PROC = '{"result":{"process_info":{"pane_id":"w5:p1","foreground_processes":[{"argv":["node","src/cli.js","dashboard"],"cmdline":"node src/cli.js dashboard","name":"MainThread","pid":69633}]},"type":"pane_process_info"}}';

// Fake herdr: logs its argv. Env knobs: $LIST (workspace list), $PANES (pane list),
// $PROC (pane process-info), $FAIL makes every call exit 1.
function fake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeherdr-"));
  const bin = path.join(dir, "herdr");
  const log = path.join(dir, "log");
  const script =
    "#!/bin/sh\n" +
    'echo "$@" >> "' + log + '"\n' +
    'if [ -n "$FAIL" ]; then echo boom >&2; exit 1; fi\n' +
    'case "$1 $2" in\n' +
    '  "workspace list") echo "$LIST";;\n' +
    '  "workspace create") echo ' + "'" + '{"result":{"root_pane":{"pane_id":"w5:p1"},"workspace":{"workspace_id":"w5","label":"llama-swap"}}}' + "'" + ';;\n' +
    '  "pane split") echo ' + "'" + '{"result":{"pane":{"pane_id":"w1:p2"}}}' + "'" + ';;\n' +
    '  "pane list") echo "$PANES";;\n' +
    '  "pane process-info") echo "$PROC";;\n' +
    "esac\n" +
    "exit 0\n";
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const open = (args, extra = {}) => {
    const r = spawnSync("node", [CLI, "open", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HERDR_BIN_PATH: bin,
        HERDR_PLUGIN_ROOT: "/plug",
        LIST: '{"result":{"workspaces":[]}}',
        PANES: DEFAULT_PANES,
        PROC: SHELL_PROC,
        HERDR_PANE_ID: "",
        HERDR_PLUGIN_CONTEXT_JSON: "",
        HERDR_WORKSPACE_ID: "",
        ...extra,
      },
    });
    return { ...r, calls: calls() };
  };
  return { open };
}

const runCalls = (calls) => calls.filter((c) => c.startsWith("pane run "));
const EX_LIST = (extra) => JSON.stringify({ result: { workspaces: [{ workspace_id: "w7", label: "llama-swap", ...extra }] } });

test("workspace: creates when none exists", () => {
  const r = fake().open([]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "w5");
  assert.match(r.calls[1], /^workspace create --cwd \/plug --label llama-swap --no-focus$/);
  assert.match(r.calls[2], /^pane run w5:p1 cd '\/plug' && node '\/plug\/src\/cli\.js' dashboard$/);
});

test("workspace: reuses existing labelled workspace, no duplicate", () => {
  const r = fake().open(["--target", "workspace"], { LIST: EX_LIST({ root_pane: { pane_id: "w7:p1" }, tokens: { model: "x" } }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "w7");
  assert.ok(r.calls.some((c) => c === "workspace focus w7"));
  assert.ok(!r.calls.some((c) => c.startsWith("workspace create")));
});

test("workspace reuse: live tokens + dead dashboard -> exactly one pane run", () => {
  const r = fake().open([], { LIST: EX_LIST({ root_pane: { pane_id: "w7:p1" }, tokens: { model: "x", tps: "8.4" } }), PROC: SHELL_PROC });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "w7");
  assert.ok(r.calls.includes("pane process-info --pane w7:p1"));
  assert.equal(runCalls(r.calls).length, 1);
  assert.match(runCalls(r.calls)[0], /^pane run w7:p1 /);
});

test("workspace reuse: dashboard already running -> zero pane run (idempotent)", () => {
  const r = fake().open([], { LIST: EX_LIST({ root_pane: { pane_id: "w7:p1" }, tokens: { model: "x" } }), PROC: DASH_PROC });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "w7");
  assert.ok(r.calls.includes("pane process-info --pane w7:p1"));
  assert.equal(runCalls(r.calls).length, 0);
  assert.ok(!r.calls.some((c) => c.startsWith("workspace create")));
});

test("workspace reuse: no root pane in workspace list -> resolved from pane list", () => {
  const panes = '{"result":{"panes":[{"pane_id":"w7:p2","workspace_id":"w7"},{"pane_id":"w7:p1","workspace_id":"w7"},{"pane_id":"w1:p1","workspace_id":"w1","focused":true}]}}';
  const r = fake().open([], { LIST: EX_LIST({ tokens: { model: "x" } }), PANES: panes, PROC: SHELL_PROC });
  assert.equal(r.status, 0);
  assert.ok(r.calls.includes("pane list"));
  assert.equal(runCalls(r.calls).length, 1);
  assert.match(runCalls(r.calls)[0], /^pane run w7:p1 /);
});

test("workspace reuse: no root pane and pane list cannot resolve -> exit 1", () => {
  const r = fake().open([], { LIST: EX_LIST({}), PANES: '{"result":{"panes":[]}}' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no root pane/);
  assert.equal(runCalls(r.calls).length, 0);
});

test("split mode resolves pane from HERDR_PANE_ID", () => {
  const r = fake().open(["--target", "split", "--json"], { HERDR_PANE_ID: "w9:p4" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).id, "w1:p2");
  assert.equal(r.calls[0], "pane split --pane w9:p4 --direction right");
  assert.match(r.calls[1], /^pane run w1:p2 /);
});

test("split mode resolves pane from plugin context JSON", () => {
  const ctx = JSON.stringify({ scope: { focused_pane: { pane_id: "w3:p2" } } });
  const r = fake().open(["--target", "split", "--json"], { HERDR_PLUGIN_CONTEXT_JSON: ctx });
  assert.equal(r.status, 0);
  assert.equal(r.calls[0], "pane split --pane w3:p2 --direction right");
});

test("split mode falls back to pane list focused:true", () => {
  const r = fake().open(["--target", "split", "--json"]);
  assert.equal(r.status, 0);
  assert.ok(r.calls.includes("pane list"));
  assert.equal(r.calls.find((c) => c.startsWith("pane split")), "pane split --pane w1:p1 --direction right");
  assert.equal(runCalls(r.calls).length, 1);
  assert.match(runCalls(r.calls)[0], /^pane run w1:p2 /);
});

test("split mode falls back to pane list matching HERDR_WORKSPACE_ID", () => {
  const panes = '{"result":{"panes":[{"pane_id":"w4:p1","workspace_id":"w4"},{"pane_id":"w2:p1","workspace_id":"w2"}]}}';
  const r = fake().open(["--target", "split", "--json"], { PANES: panes, HERDR_WORKSPACE_ID: "w4" });
  assert.equal(r.status, 0);
  assert.equal(r.calls.find((c) => c.startsWith("pane split")), "pane split --pane w4:p1 --direction right");
});

test("split mode with no resolvable pane -> exit 1, no split", () => {
  const r = fake().open(["--target", "split"], { PANES: '{"result":{"panes":[]}}' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no focused pane to split/);
  assert.ok(!r.calls.some((c) => c.startsWith("pane split")));
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
