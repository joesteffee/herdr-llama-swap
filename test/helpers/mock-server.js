import http from "node:http";

export const PROM = `# HELP llamaswap_cpu_util_percent CPU
# TYPE llamaswap_cpu_util_percent gauge
llamaswap_cpu_util_percent{core="0"} 10
llamaswap_cpu_util_percent{core="1"} 30
llamaswap_cpu_util_percent{core="2"} 50
llamaswap_memory_used_bytes 1073741824
llamaswap_memory_total_bytes 4294967296
llamaswap_gpu_util_percent{id="0",name="RTX"} 91
llamaswap_gpu_memory_used_bytes{id="0",name="RTX"} 7.10934528e+09
llamaswap_gpu_memory_total_bytes{id="0",name="RTX"} 8.585740288e+09
llamaswap_gpu_temperature_celsius{id="0",name="RTX"} 52
llamaswap_gpu_fan_speed_percent{id="0",name="RTX"} 51
llamaswap_gpu_power_draw_watts{id="0",name="RTX"} 80
llamaswap_gpu_util_percent{id="1",name="Other"} 5
`;

export const MODELS = {
  data: [
    { id: "inkling-2-mini", name: "Inkling", status: { value: "loaded" } },
    { id: "flash-next", name: "Flash", status: { value: "unloaded" } },
  ],
};
export const RUNNING = { running: [{ model: "inkling-2-mini", state: "ready", proxy: "http://127.0.0.1:5802", ttl: 900, name: "Inkling" }] };
export const SLOTS = [
  { id: 0, n_ctx: 131072, is_processing: true, n_prompt_tokens: 1000, n_prompt_tokens_processed: 1000, n_prompt_tokens_cache: 5, next_token: [{ n_decoded: 40, n_remain: 100 }] },
];

/** Mock llama-swap. Mutable: server.routes override, server.posts records POSTs. */
export async function startMock(overrides = {}) {
  const posts = [];
  const routes = {
    "GET /health": () => [200, "OK", "text/plain"],
    "GET /v1/models": () => [200, MODELS],
    "GET /running": () => [200, RUNNING],
    "GET /metrics": () => [200, PROM, "text/plain"],
    "GET /upstream/inkling-2-mini/slots": () => [200, SLOTS],
    "GET /upstream/inkling-2-mini/metrics": () => [501, "not implemented"],
    "GET /api/models/pause": () => [405, "method not allowed"],
    "GET /boom": () => [500, "x".repeat(500)],
    ...overrides,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "POST") posts.push({ path: req.url, body });
      const key = `${req.method} ${req.url}`;
      let h = routes[key];
      if (!h && req.method === "POST" && req.url.startsWith("/api/models/")) h = () => [200, "OK", "text/plain"];
      const [code, payload, type] = h ? h(body) : [404, "not found", "text/plain"];
      const isObj = typeof payload !== "string";
      res.writeHead(code, { "content-type": isObj ? "application/json" : type || "text/plain" });
      res.end(isObj ? JSON.stringify(payload) : payload);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, posts, routes, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
