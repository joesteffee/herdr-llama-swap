import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { LlamaSwapClient, parseProm, summarizeMetrics } from "../src/lib/client.js";
import { resolveConfig, DEFAULT_URL } from "../src/lib/config.js";
import { startMock, PROM } from "./helpers/mock-server.js";

let mock, client;
before(async () => {
  mock = await startMock();
  client = new LlamaSwapClient(mock.url, { timeoutMs: 2000 });
});
after(() => mock.close());

test("health/models/running/slots parse", async () => {
  assert.equal(await client.health(), "OK");
  const models = await client.models();
  assert.equal(models.length, 2);
  assert.equal(models[0].status.value, "loaded");
  assert.equal((await client.running())[0].model, "inkling-2-mini");
  const slots = await client.slots("inkling-2-mini");
  assert.equal(slots[0].n_ctx, 131072);
});

test("prometheus aggregation: cpu average, single GPU id 0, memory", () => {
  const m = summarizeMetrics(PROM);
  assert.equal(m.host.cpuPercentAvg, 30);
  assert.equal(m.host.cpuCores, 3);
  assert.equal(m.host.memUsedBytes, 1073741824);
  assert.equal(m.gpu.id, "0");
  assert.equal(m.gpu.utilPercent, 91);
  assert.equal(m.gpu.vramTotalBytes, 8585740288);
  assert.equal(m.gpu.tempC, 52);
  assert.equal(summarizeMetrics("").gpu, null);
});

test("parseProm handles labels and skips comments", () => {
  const p = parseProm('# HELP x\nfoo{a="1",b="two"} 3.5\nbar 2\nbad line\n');
  assert.deepEqual(p[0], { name: "foo", labels: { a: "1", b: "two" }, value: 3.5 });
  assert.equal(p.length, 2);
});

test("405, 404 and 500 errors include status and truncated body", async () => {
  await assert.rejects(client.slots("missing"), /HTTP 404/);
  mock.routes["GET /health"] = () => [500, "y".repeat(500)];
  try {
    await client.health();
    assert.fail("should throw");
  } catch (e) {
    assert.match(e.message, /HTTP 500: y+/);
    assert.ok(e.message.length < 300, "body truncated to 200 chars");
  }
  mock.routes["GET /health"] = () => [200, "OK", "text/plain"];
  mock.routes["POST /api/models/pause"] = () => [405, "nope"];
  await assert.rejects(client.pause(), /HTTP 405: nope/);
  delete mock.routes["POST /api/models/pause"];
});

test("501 on upstream metrics surfaces as error", async () => {
  const raw = new LlamaSwapClient(mock.url);
  mock.routes["GET /upstream/x/slots"] = () => [501, "not implemented"];
  await assert.rejects(raw.slots("x"), /HTTP 501: not implemented/);
});

test("unload / pause / resume POST to the right paths", async () => {
  mock.posts.length = 0;
  await client.unload("inkling-2-mini");
  await client.pause();
  await client.resume();
  assert.deepEqual(mock.posts.map((p) => p.path), ["/api/models/unload/inkling-2-mini", "/api/models/pause", "/api/models/resume"]);
});

test("unreachable server gives a clear error", async () => {
  const c = new LlamaSwapClient("http://127.0.0.1:1", { timeoutMs: 500 });
  await assert.rejects(c.health(), /GET http:\/\/127\.0\.0\.1:1\/health failed/);
});

test("config resolution order", () => {
  assert.equal(resolveConfig({ url: "http://a/", env: { LLAMASWAP_URL: "http://b" } }).url, "http://a");
  assert.equal(resolveConfig({ env: { LLAMASWAP_URL: "http://b" } }).url, "http://b");
  assert.equal(resolveConfig({ env: {} }).url, DEFAULT_URL);
  assert.equal(resolveConfig({ pollMs: 10, env: {} }).pollMs, 500);
});
