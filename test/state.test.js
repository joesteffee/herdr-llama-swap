import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveState, computeRates, proxyPortOf } from "../src/lib/state.js";
import { MODELS, RUNNING, SLOTS } from "./helpers/mock-server.js";

const slot = (over = {}) => [{ ...SLOTS[0], ...over }];

test("offline when health fails", () => {
  const s = deriveState({ online: false, error: "boom", nowMs: 1 });
  assert.equal(s.status, "offline");
  assert.equal(s.loaded, null);
  assert.equal(s.lastError, "boom");
});

test("none when running is empty and nothing is loaded", () => {
  const models = { data: MODELS.data.map((m) => ({ ...m, status: { value: "unloaded" } })) }.data;
  const s = deriveState({ models, running: [], nowMs: 1 });
  assert.equal(s.status, "online");
  assert.equal(s.loaded, null);
  assert.equal(s.phase, "none");
});

test("loading when /v1/models says loaded but /running is empty", () => {
  const s = deriveState({ models: MODELS.data, running: [], nowMs: 1 });
  assert.equal(s.phase, "loading");
  assert.equal(s.loaded, "inkling-2-mini");
});

test("swapping when the running model is not ready and differs from prev", () => {
  const running = [{ ...RUNNING.running[0], model: "flash-next", state: "starting" }];
  const s = deriveState({ models: MODELS.data, running, prev: { loaded: "inkling-2-mini" }, nowMs: 1 });
  assert.equal(s.phase, "swapping");
});

test("prompt vs decode vs idle phases", () => {
  const base = { models: MODELS.data, running: RUNNING.running, nowMs: 1 };
  assert.equal(deriveState({ ...base, slots: slot({ n_prompt_tokens_processed: 500 }) }).phase, "prompt");
  assert.equal(deriveState({ ...base, slots: slot() }).phase, "decode");
  assert.equal(deriveState({ ...base, slots: slot({ is_processing: false }) }).phase, "idle");
});

test("context, ttl and proxy port come through", () => {
  const s = deriveState({ models: MODELS.data, running: RUNNING.running, slots: SLOTS, nowMs: 1 });
  assert.equal(s.context.nCtx, 131072);
  assert.equal(s.context.promptTokens, 1000);
  assert.equal(s.context.nRemain, 100);
  assert.equal(s.ttlSec, 900);
  assert.equal(s.proxyPort, 5802);
  assert.equal(proxyPortOf("garbage"), null);
});

test("computeRates: deltas, null cases", () => {
  const r = computeRates({ nDecoded: 10, promptProcessed: 0 }, { nDecoded: 30, promptProcessed: 500 }, 2000);
  assert.equal(r.decodeTps, 10);
  assert.equal(r.promptTps, 250);
  assert.deepEqual(computeRates(null, { nDecoded: 1 }, 1000), { decodeTps: null, promptTps: null });
  assert.equal(computeRates({ nDecoded: 5 }, { nDecoded: 6 }, 0).decodeTps, null);
  assert.equal(computeRates({ nDecoded: 50 }, { nDecoded: 6 }, 1000).decodeTps, null);
});

test("rates derive across two samples via prev state", () => {
  const base = { models: MODELS.data, running: RUNNING.running };
  const s1 = deriveState({ ...base, slots: slot({ next_token: [{ n_decoded: 40, n_remain: 100 }] }), nowMs: 10000 });
  assert.equal(s1.rates.decodeTps, null);
  const s2 = deriveState({ ...base, slots: slot({ next_token: [{ n_decoded: 60, n_remain: 80 }] }), prev: s1, nowMs: 12000 });
  assert.equal(s2.rates.decodeTps, 10);
  const s3 = deriveState({ ...base, slots: slot({ next_token: [{ n_decoded: 0, n_remain: 80 }] }), prev: s2, nowMs: 14000 });
  assert.equal(s3.rates.decodeTps, null, "counter reset yields null");
});
