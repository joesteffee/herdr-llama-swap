const DEFAULT_TIMEOUT_MS = 5000;

/** Parse Prometheus text into [{name, labels, value}]. */
export function parseProm(text) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const value = Number(m[4]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (m[3]) {
      for (const lm of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    }
    out.push({ name: m[1], labels, value });
  }
  return out;
}

/** Aggregate llama-swap system metrics. GPU values come from id="0" (or the first GPU seen). */
export function summarizeMetrics(text) {
  const samples = parseProm(text);
  const cores = samples.filter((s) => s.name === "llamaswap_cpu_util_percent");
  const first = (name) => samples.find((s) => s.name === name)?.value ?? null;
  const gpuSamples = samples.filter((s) => s.name.startsWith("llamaswap_gpu_"));
  const gpuId = gpuSamples.some((s) => s.labels.id === "0") ? "0" : gpuSamples[0]?.labels.id;
  const g = (name) => gpuSamples.find((s) => s.name === "llamaswap_gpu_" + name && s.labels.id === gpuId)?.value ?? null;
  const gpu = gpuSamples.length
    ? {
        id: gpuId ?? null,
        name: gpuSamples[0].labels.name ?? null,
        utilPercent: g("util_percent"),
        vramUsedBytes: g("memory_used_bytes"),
        vramTotalBytes: g("memory_total_bytes"),
        tempC: g("temperature_celsius"),
        fanPercent: g("fan_speed_percent"),
        powerW: g("power_draw_watts"),
      }
    : null;
  const memUsed = first("llamaswap_memory_used_bytes");
  const memTotal = first("llamaswap_memory_total_bytes");
  return {
    gpu,
    host:
      memUsed == null && !cores.length
        ? null
        : {
            memUsedBytes: memUsed,
            memTotalBytes: memTotal,
            cpuPercentAvg: cores.length ? cores.reduce((a, s) => a + s.value, 0) / cores.length : null,
            cpuCores: cores.length,
          },
  };
}

export class LlamaSwapClient {
  constructor(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async #request(method, path, { body, timeoutMs } = {}) {
    const url = this.baseUrl + path;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
      throw new Error(`${method} ${url} failed: ${cause}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }

  async #json(method, path, opts) {
    const text = await this.#request(method, path, opts);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${method} ${this.baseUrl}${path} returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  async health() {
    return (await this.#request("GET", "/health")).trim();
  }
  async models() {
    const j = await this.#json("GET", "/v1/models");
    return Array.isArray(j?.data) ? j.data : [];
  }
  async running() {
    const j = await this.#json("GET", "/running");
    return Array.isArray(j?.running) ? j.running : [];
  }
  async slots(model) {
    const j = await this.#json("GET", `/upstream/${encodeURIComponent(model)}/slots`);
    return Array.isArray(j) ? j : [];
  }
  async promMetrics() {
    return this.#request("GET", "/metrics");
  }
  async metrics() {
    return summarizeMetrics(await this.promMetrics());
  }
  async unload(id) {
    return this.#request("POST", `/api/models/unload/${encodeURIComponent(id)}`);
  }
  async pause() {
    return this.#request("POST", "/api/models/pause");
  }
  async resume() {
    return this.#request("POST", "/api/models/resume");
  }
  /** On-demand swap: llama-swap loads a model when a request names it. Long timeout: loading can take minutes. */
  async warmUp(id) {
    return this.#request("POST", "/v1/completions", {
      body: { model: id, prompt: "", max_tokens: 1 },
      timeoutMs: 10 * 60 * 1000,
    });
  }
}
