/** Pure state derivation. No I/O. */

export function computeRates(prev, cur, dtMs) {
  const out = { decodeTps: null, promptTps: null };
  if (!prev || !cur || !(dtMs > 0)) return out;
  const rate = (a, b) => {
    if (a == null || b == null) return null;
    const d = b - a;
    return d < 0 ? null : d / (dtMs / 1000);
  };
  out.decodeTps = rate(prev.nDecoded, cur.nDecoded);
  out.promptTps = rate(prev.promptProcessed, cur.promptProcessed);
  return out;
}

export function proxyPortOf(proxy) {
  try {
    const u = new URL(proxy);
    return u.port ? Number(u.port) : null;
  } catch {
    return null;
  }
}

function sumSlots(slots) {
  let nDecoded = 0;
  let promptProcessed = 0;
  for (const s of slots) {
    nDecoded += s.next_token?.[0]?.n_decoded ?? 0;
    promptProcessed += s.n_prompt_tokens_processed ?? 0;
  }
  return { nDecoded, promptProcessed };
}

/**
 * @param {{online?:boolean, models?:any[], running?:any[], slots?:any[], metrics?:any, prev?:any, nowMs?:number, error?:string|null}} a
 * prev is the previous derived state (its .sample is used for rates).
 */
export function deriveState({ online = true, models = [], running = [], slots = [], metrics = null, prev = null, nowMs = Date.now(), error = null } = {}) {
  const base = {
    status: "online",
    loaded: null,
    modelName: null,
    phase: "none",
    context: { nCtx: null, promptTokens: null, promptProcessed: null, cacheTokens: null, nDecoded: null, nRemain: null },
    rates: { decodeTps: null, promptTps: null },
    gpu: metrics?.gpu ?? null,
    host: metrics?.host ?? null,
    ttlSec: null,
    proxyPort: null,
    sample: null,
    lastError: error,
    updatedAt: nowMs,
  };
  if (!online) return { ...base, status: "offline", gpu: null, host: null };

  const run = running[0] ?? null;
  const loadingModel = models.find((m) => m?.status?.value === "loaded" && !running.some((r) => r.model === m.id));

  if (!run) {
    if (loadingModel) {
      return { ...base, loaded: loadingModel.id, modelName: loadingModel.name ?? null, phase: "loading" };
    }
    return base;
  }

  const meta = models.find((m) => m.id === run.model);
  base.loaded = run.model;
  base.modelName = run.name ?? meta?.name ?? null;
  base.ttlSec = run.ttl ?? null;
  base.proxyPort = proxyPortOf(run.proxy);

  if (run.state && run.state !== "ready") {
    base.phase = prev?.loaded && prev.loaded !== run.model ? "swapping" : "loading";
    return base;
  }

  const slot0 = slots[0];
  if (!slot0) {
    base.phase = "idle";
    if (error) base.status = "degraded";
    return base;
  }
  const cur = sumSlots(slots);
  base.context = {
    nCtx: slot0.n_ctx ?? null,
    promptTokens: slot0.n_prompt_tokens ?? null,
    promptProcessed: slot0.n_prompt_tokens_processed ?? null,
    cacheTokens: slot0.n_prompt_tokens_cache ?? null,
    nDecoded: slot0.next_token?.[0]?.n_decoded ?? null,
    nRemain: slot0.next_token?.[0]?.n_remain ?? null,
  };
  base.sample = { atMs: nowMs, model: run.model, ...cur };
  const ps = prev?.sample;
  if (ps && ps.model === run.model) base.rates = computeRates(ps, cur, nowMs - ps.atMs);

  if (slot0.is_processing === true) {
    base.phase = (slot0.n_prompt_tokens_processed ?? 0) < (slot0.n_prompt_tokens ?? 0) ? "prompt" : "decode";
  } else {
    base.phase = "idle";
  }
  if (error) base.status = "degraded";
  return base;
}
