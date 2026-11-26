import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as herdr from "../src/lib/herdr.js";

const STATE = { loaded: "m", phase: "idle", rates: {}, gpu: null };

// Fake herdr: live workspace id in $LIVE ("" = none); logs each call.
function fake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeherdr-"));
  const bin = path.join(dir, "herdr");
  const log = path.join(dir, "log");
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1 $2" = "workspace list" ]; then
  if [ -n "$LIVE" ]; then echo '{"result":{"workspaces":[{"id":"'$LIVE'","focused":true}]}}'; else echo '{"result":{"workspaces":[]}}'; fi
  exit 0
fi
if [ "$1 $2" = "workspace report-metadata" ]; then
  if [ "$3" = "$LIVE" ]; then exit 0; fi
  echo '{"error":{"code":"workspace_not_found","message":"workspace '$3' not found"}}' >&2
  exit 1
fi
exit 0
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  return { env: (live, ws = "w4") => ({ ...process.env, HERDR_BIN_PATH: bin, HERDR_WORKSPACE_ID: ws, LIVE: live }), calls };
}

beforeEach(() => herdr.resetWorkspaceCache());

test("stale env id -> re-resolves from workspace list and retries", async () => {
  const f = fake();
  const r = await herdr.reportTokens(STATE, { env: f.env("w9") });
  assert.equal(r.ok, true);
  const c = f.calls();
  assert.equal(c.length, 3);
  assert.match(c[0], /report-metadata w4/);
  assert.match(c[1], /workspace list/);
  assert.match(c[2], /report-metadata w9/);
});

test("no workspace at all -> ok:false, no crash", async () => {
  const f = fake();
  const r = await herdr.reportTokens(STATE, { env: f.env("") });
  assert.equal(r.ok, false);
  assert.equal(r.stderr, "no workspace id");
});

test("second call reuses cached id without workspace list", async () => {
  const f = fake();
  await herdr.reportTokens(STATE, { env: f.env("w9") });
  const before = f.calls().length;
  const r = await herdr.reportTokens(STATE, { env: f.env("w9") });
  assert.equal(r.ok, true);
  const after = f.calls().slice(before);
  assert.equal(after.length, 1);
  assert.match(after[0], /report-metadata w9/);
});

test("cached id that disappears is invalidated and re-resolved", async () => {
  const f = fake();
  await herdr.reportTokens(STATE, { env: f.env("w9") });
  const r = await herdr.reportTokens(STATE, { env: f.env("w10") });
  assert.equal(r.ok, true);
  assert.match(f.calls().at(-1), /report-metadata w10/);
});
