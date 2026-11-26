import { execFile } from "node:child_process";

export function herdrBin(env = process.env) {
  return env.HERDR_BIN_PATH || "herdr";
}

/** Run herdr; NEVER throws. Resolves {ok, stdout, stderr}. */
export function runHerdr(args, { env = process.env, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(herdrBin(env), args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, stdout: String(stdout || ""), stderr: String(stderr || err.message) });
        else resolve({ ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: String(err?.message || err) });
    }
  });
}

/** Accept bare JSON or {"result":{...}} envelope. */
export function unwrap(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && "result" in j ? j.result : j;
  } catch {
    return null;
  }
}

export function pickFocusedWorkspace(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.workspaces;
  if (!Array.isArray(list) || !list.length) return null;
  const w = list.find((x) => x?.focused === true || x?.is_focused === true || x?.active === true) ?? null;
  return w ? (w.id ?? w.workspace_id ?? null) : null;
}

export async function resolveWorkspaceId(opts = {}) {
  const env = opts.env || process.env;
  if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  const r = await runHerdr(["workspace", "list"], opts);
  if (!r.ok) return null;
  return pickFocusedWorkspace(unwrap(r.stdout));
}

export function formatTokens(state, pollMs) {
  const gib = (b) => (b / 1024 ** 3).toFixed(1);
  const g = state.gpu;
  const tps = state.rates?.decodeTps ?? state.rates?.promptTps;
  const tokens = {
    model: state.loaded ?? "none",
    phase: state.status === "offline" ? "offline" : state.phase,
    tps: tps == null ? "-" : tps.toFixed(1),
  };
  if (g?.vramUsedBytes != null && g?.vramTotalBytes != null) tokens.vram = `${gib(g.vramUsedBytes)}/${gib(g.vramTotalBytes)} GiB`;
  return { tokens, ttlMs: pollMs * 4 };
}

export async function reportTokens(state, { pollMs = 2000, env = process.env, workspaceId } = {}) {
  const ws = workspaceId || (await resolveWorkspaceId({ env }));
  if (!ws) return { ok: false, stderr: "no workspace id" };
  const { tokens, ttlMs } = formatTokens(state, pollMs);
  const args = ["workspace", "report-metadata", ws, "--source", "llama-swap", "--ttl-ms", String(ttlMs)];
  for (const [k, v] of Object.entries(tokens)) args.push("--token", `${k}=${v}`);
  const r = await runHerdr(args, { env });
  return { ok: r.ok, stderr: r.stderr };
}

export async function notify(title, body = "", { env = process.env } = {}) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  const r = await runHerdr(args, { env });
  return { ok: r.ok, stderr: r.stderr };
}
