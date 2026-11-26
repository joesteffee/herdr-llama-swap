import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("src/cli.js");

const mkDoc = () => ({
  spaces: [
    {
      folder: "",
      id: "sp46d3c85fd5331c71b3fe92cde1678342",
      name: "",
      tabs: [
        { id: "tbaaa", name: "ombi requests", root: { type: "row", id: "tbaaa", children: [{ type: "block", id: "pbaaa", content: { terminal: "t27" } }] } },
        { id: "tbbbb", name: "other", root: { type: "row", id: "tbbbb", children: [{ type: "block", id: "pbbbb", content: { terminal: "t28" } }] } },
      ],
    },
    { folder: "x", id: "sp2", name: "second", tabs: [{ id: "tbccc", name: "llama-swap", root: { type: "row", id: "tbccc", children: [{ type: "block", id: "pbccc", content: { terminal: "t99" } }] } }] },
  ],
});
const statusSpace = (term) => ({
  folder: "/home/herdr",
  id: "spa70b82e879ddea15c68a4adf52e56d04",
  name: "status",
  tabs: term === undefined ? [] : [{ id: "tbec03", name: "llama-swap", root: { type: "row", id: "tbec03", children: [{ type: "block", id: "pbec03", content: { terminal: term } }] } }],
});
const withTab = (term) => {
  const d = mkDoc();
  d.spaces.unshift(statusSpace(term));
  return d;
};
const DASH_GET = '{"address":"t2v","argv":["node","src/cli.js","dashboard"],"state":"live","name":"llama-swap","foreground":{"argv":["/usr/bin/node","/x/herdr-llama-swap/src/cli.js","dashboard"],"name":"MainThread","pid":1}}';
const SHELL_GET = '{"address":"t2v","argv":["node","src/cli.js","dashboard"],"state":"live","name":"llama-swap","foreground":{"argv":["zsh"],"name":"zsh","pid":1}}';
const lsOf = (terms) => JSON.stringify({ hidden_finished: 0, terminals: terms });
const LIVE = { address: "t2v", agent: "node", name: "llama-swap", state: "live" };
const OTHER = { address: "t2w", agent: "pi", name: "other-agent", state: "live" };

// Fake herdr-core: logs argv ($DIR/log) and connect requests ($DIR/rpc). Env: LS, GET, DOC (file),
// CONFLICT=1 (first doc.set conflicts, version bumps), FAIL=1 (everything exits 1).
function fake(doc = mkDoc()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakehc-"));
  const bin = path.join(dir, "herdr-core");
  const log = path.join(dir, "log");
  const rpcLog = path.join(dir, "rpc");
  fs.writeFileSync(path.join(dir, "doc.json"), JSON.stringify(doc));
  fs.writeFileSync(path.join(dir, "ver"), "120");
  const script =
    "#!/bin/sh\n" +
    'D="' + dir + '"\n' +
    'echo "$@" >> "$D/log"\n' +
    'if [ -n "$FAIL" ]; then echo boom >&2; exit 1; fi\n' +
    'case "$1" in\n' +
    '  ls) if [ -n "$RUN_NO_ADDR" ] && [ -f "$D/ran" ]; then echo "$LS_AFTER"; else echo "$LS"; fi;;\n' +
    '  get) echo "$GET";;\n' +
    '  rm) ;;\n' +
    '  run) touch "$D/ran"; if [ -n "$RUN_NO_ADDR" ]; then echo \'{"name":"llama-swap","state":"live"}\'; else echo \'{"address":"t9z","name":"llama-swap","state":"live"}\'; fi;;\n' +
    "  connect)\n" +
    "    read line\n" +
    '    echo "$line" >> "$D/rpc"\n' +
    '    id=$(echo "$line" | sed \'s/^{"jsonrpc":"2.0","id":\\([0-9]*\\).*/\\1/\')\n' +
    '    ver=$(cat "$D/ver")\n' +
    '    if echo "$line" | grep -q \'"method":"doc.get"\'; then\n' +
    '      echo "{\\"id\\":$id,\\"jsonrpc\\":\\"2.0\\",\\"result\\":{\\"value\\":$(cat "$D/doc.json"),\\"version\\":$ver}}"\n' +
    '    else\n' +
    '      if [ -n "$CONFLICT" ] && { [ "$CONFLICT" = always ] || [ ! -f "$D/conflicted" ]; }; then\n' +
    '        touch "$D/conflicted"; echo $((ver+1)) > "$D/ver"\n' +
    '        echo "{\\"id\\":$id,\\"jsonrpc\\":\\"2.0\\",\\"error\\":{\\"code\\":-32010,\\"message\\":\\"version conflict\\"}}"\n' +
    "      else\n" +
    '        echo "$line" | sed \'s/^.*"value":\\(.*\\),"version":[0-9]*}}$/\\1/\' > "$D/doc.json"; echo $((ver+1)) > "$D/ver"\n' +
    '        echo "{\\"id\\":$id,\\"jsonrpc\\":\\"2.0\\",\\"result\\":{\\"version\\":$((ver+1))}}"\n' +
    "      fi\n" +
    "    fi;;\n" +
    "esac\n" +
    "exit 0\n";
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
  const dir_ = dir;
  const open = (args, extra = {}) => {
    const r = spawnSync("node", [CLI, "open", ...args], {
      encoding: "utf8",
      env: { ...process.env, HERDR_CORE_BIN: bin, HERDR_PLUGIN_ROOT: "/plug", LS: lsOf([]), GET: "", ...extra },
    });
    const rpcs = lines(rpcLog).map((l) => JSON.parse(l));
    return { ...r, calls: lines(log), rpcs, sets: rpcs.filter((x) => x.method === "doc.set"), gets: rpcs.filter((x) => x.method === "doc.get") };
  };
  return { open, dir: dir_ };
}

const runs = (c) => c.filter((x) => x.startsWith("run "));

test("hc fresh: runs terminal, one doc.set, tab inserted at index 0 with row id === tab id", () => {
  const r = fake().open(["--target", "hc"], { LS: lsOf([OTHER]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "t9z");
  assert.equal(runs(r.calls).length, 1);
  assert.equal(r.calls.find((c) => c.startsWith("run ")), "run --bg --json --no-parent --no-notify --name llama-swap --cwd /plug node /plug/src/cli.js dashboard");
  assert.ok(!r.calls.some((c) => c.startsWith("rm ")));
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].params.name, "herdr-app");
  assert.equal(r.sets[0].params.version, 120);
  const v = r.sets[0].params.value;
  const tab = v.spaces[0].tabs[0];
  assert.equal(tab.name, "llama-swap");
  assert.match(tab.id, /^tb[0-9a-f]{32}$/);
  assert.equal(tab.root.type, "row");
  assert.equal(tab.root.id, tab.id);
  assert.match(tab.root.children[0].id, /^pb[0-9a-f]{32}$/);
  assert.equal(tab.root.children[0].type, "block");
  assert.deepEqual(tab.root.children[0].content, { terminal: "t9z" });
  assert.equal(v.spaces.length, 3);
  assert.equal(v.spaces[0].name, "status");
  assert.match(v.spaces[0].id, /^sp[0-9a-f]{32}$/);
  assert.equal(v.spaces[0].tabs.length, 1);
  assert.deepEqual(v.spaces.slice(1), mkDoc().spaces);
});

test("hc existing live terminal + existing tab: no run, one doc.set changing only content.terminal", () => {
  const f = fake(withTab("tOLD"));
  const r = f.open(["--target", "hc"], { LS: lsOf([LIVE, OTHER]), GET: DASH_GET });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "t2v");
  assert.equal(runs(r.calls).length, 0);
  assert.ok(r.calls.includes("get t2v"));
  assert.equal(r.sets.length, 1);
  const expected = withTab("t2v");
  assert.deepEqual(r.sets[0].params.value, expected);
  const orig = withTab("tOLD");
  assert.notDeepEqual(r.sets[0].params.value, orig);
  assert.equal(r.sets[0].params.value.spaces[0].tabs[0].id, "tbec03");
  assert.deepEqual(r.sets[0].params.value.spaces.slice(1), orig.spaces.slice(1));
});

test("hc dead terminal with the right name: rm before run", () => {
  const r = fake().open(["--target", "hc"], { LS: lsOf([{ ...LIVE, state: "finished" }]) });
  assert.equal(r.status, 0, r.stderr);
  const rm = r.calls.findIndex((c) => c === "rm t2v");
  const run = r.calls.findIndex((c) => c.startsWith("run "));
  assert.ok(rm >= 0 && run > rm, r.calls.join(" | "));
  assert.equal(r.stdout.trim(), "t9z");
});

test("hc live terminal whose foreground is not the dashboard: rm then run", () => {
  const r = fake().open(["--target", "hc"], { LS: lsOf([LIVE]), GET: SHELL_GET });
  assert.equal(r.status, 0, r.stderr);
  const kill = r.calls.findIndex((c) => c === "kill t2v");
  const rm = r.calls.findIndex((c) => c === "rm t2v");
  const run = r.calls.findIndex((c) => c.startsWith("run "));
  assert.ok(kill >= 0, r.calls.join(" | "));
  assert.ok(kill < rm && rm < run, r.calls.join(" | "));
});

test("hc run reply without address: falls back to ls for the live llama-swap terminal", () => {
  const r = fake().open(["--target", "hc"], {
    LS: lsOf([OTHER]),
    RUN_NO_ADDR: "1",
    LS_AFTER: lsOf([OTHER, { address: "t7q", name: "llama-swap", state: "live" }]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "t7q");
  assert.equal(r.sets.length, 1);
  assert.deepEqual(r.sets[0].params.value.spaces[0].tabs[0].root.children[0].content, { terminal: "t7q" });
});

test("hc doc.set conflict: re-reads, retries once, exits 0", () => {
  const r = fake().open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET, CONFLICT: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.gets.length, 2);
  assert.equal(r.sets.length, 2);
  assert.equal(r.sets[0].params.version, 120);
  assert.equal(r.sets[1].params.version, 121);
});

test("hc: persistent conflict gives up after one retry (exit 1, one stderr line)", () => {
  const r = fake().open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET, CONFLICT: "always" });
  assert.equal(r.status, 1);
  assert.equal(r.gets.length, 2);
  assert.equal(r.sets.length, 2);
  assert.equal(r.stderr.trim().split("\n").length, 1);
});

test("hc: herdr-core missing -> exit 1, one stderr line, no stdout", () => {
  const r = spawnSync("node", [CLI, "open", "--target", "hc"], {
    encoding: "utf8",
    env: { ...process.env, HERDR_CORE_BIN: "/nonexistent/herdr-core", HERDR_PLUGIN_ROOT: "/plug" },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});

test("hc: herdr-core failing (FAIL=1) -> exit 1, one stderr line", () => {
  const r = fake().open(["--target", "hc"], { FAIL: "1" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1);
});

test("hc: empty/missing spaces -> failure, no doc.set", () => {
  const r = fake({ spaces: [] }).open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /spaces\[0\]/);
  assert.equal(r.sets.length, 0);
});

test("hc-tab alias behaves like hc and --json has kind hc-tab", () => {
  const r = fake().open(["--target", "hc-tab", "--json"], { LS: lsOf([LIVE]), GET: DASH_GET });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.kind, "hc-tab");
  assert.equal(j.id, "t2v");
  assert.equal(j.tab, r.sets[0].params.value.spaces[0].tabs[0].id);
});

test("hc: bare stdout is the address only; herdr (not herdr-core) is never needed", () => {
  const r = fake().open(["--target=hc"], { LS: lsOf([LIVE]), GET: DASH_GET, HERDR_BIN_PATH: "/nonexistent/herdr" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "t2v\n");
});

test("hc: status space present, no llama-swap tab -> tab added inside it, nothing else changes", () => {
  const doc = mkDoc();
  doc.spaces.unshift(statusSpace());
  doc.spaces[0].tabs.push({ id: "tbzzz", name: "other-status", root: { type: "row", id: "tbzzz", children: [] } });
  const r = fake(doc).open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.sets.length, 1);
  const v = r.sets[0].params.value;
  assert.equal(v.spaces.filter((s) => s.name === "status").length, 1);
  assert.deepEqual(v.spaces.map((s) => s.id), doc.spaces.map((s) => s.id));
  assert.equal(v.spaces[0].tabs[0].name, "llama-swap");
  assert.match(v.spaces[0].tabs[0].id, /^tb[0-9a-f]{32}$/);
  assert.deepEqual(v.spaces[0].tabs.slice(1), doc.spaces[0].tabs);
  assert.deepEqual(v.spaces.slice(1), doc.spaces.slice(1));
});

test("hc: default space (name \"\") with a stray llama-swap tab is never used; status space created", () => {
  const doc = mkDoc();
  doc.spaces[0].tabs.unshift({ id: "tbstray", name: "llama-swap", root: { type: "row", id: "tbstray", children: [{ type: "block", id: "pbstray", content: { terminal: "t1" } }] } });
  const r = fake(doc).open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET });
  assert.equal(r.status, 0, r.stderr);
  const v = r.sets[0].params.value;
  assert.equal(v.spaces[0].name, "status");
  assert.equal(v.spaces[0].tabs.length, 1);
  assert.equal(v.spaces[0].tabs[0].root.children[0].content.terminal, "t2v");
  assert.deepEqual(v.spaces.slice(1), doc.spaces);
});

test("hc: status space with non-array tabs -> failure, no doc.set", () => {
  const doc = mkDoc();
  doc.spaces.unshift({ ...statusSpace(), tabs: "nope" });
  const r = fake(doc).open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET });
  assert.equal(r.status, 1);
  assert.equal(r.sets.length, 0);
});

test("hc: idempotent across two runs (doc.set persisted by the fake)", () => {
  const f = fake();
  const r1 = f.open(["--target", "hc"], { LS: lsOf([OTHER]) });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = f.open(["--target", "hc"], { LS: lsOf([LIVE]), GET: DASH_GET });
  assert.equal(r2.status, 0, r2.stderr);
  const doc = JSON.parse(fs.readFileSync(path.join(f.dir, "doc.json"), "utf8"));
  assert.equal(doc.spaces.filter((s) => s.name === "status").length, 1);
  assert.equal(doc.spaces.length, 3);
  assert.equal(doc.spaces[0].tabs.length, 1);
  assert.equal(doc.spaces[0].tabs[0].root.children[0].content.terminal, "t2v");
  assert.deepEqual(doc.spaces.slice(1), mkDoc().spaces);
});
