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

let cachedWorkspaceId = null;

/** Test hook: forget the validated workspace id. */
export function resetWorkspaceCache() {
  cachedWorkspaceId = null;
}

async function listFocusedWorkspace(env) {
  const r = await runHerdr(["workspace", "list"], { env });
  if (!r.ok) return null;
  return pickFocusedWorkspace(unwrap(r.stdout));
}

/**
 * Report tokens. Candidate order: explicit workspaceId, validated module cache, env HERDR_WORKSPACE_ID
 * (a first guess only). If the call fails with workspace_not_found (or a non-validated env id failed),
 * drop the cache, re-resolve via `herdr workspace list` and retry once. Only an id that worked is cached.
 */
export async function reportTokens(state, { pollMs = 2000, env = process.env, workspaceId } = {}) {
  const { tokens, ttlMs } = formatTokens(state, pollMs);
  const send = (ws) => {
    const args = ["workspace", "report-metadata", ws, "--source", "llama-swap", "--ttl-ms", String(ttlMs)];
    for (const [k, v] of Object.entries(tokens)) args.push("--token", `${k}=${v}`);
    return runHerdr(args, { env });
  };
  const ws = workspaceId || cachedWorkspaceId || env.HERDR_WORKSPACE_ID || null;
  const validated = !!ws && ws === cachedWorkspaceId;
  if (ws) {
    const r = await send(ws);
    if (r.ok) {
      cachedWorkspaceId = ws;
      return { ok: true, stderr: r.stderr };
    }
    const notFound = /workspace_not_found/.test(r.stderr + r.stdout);
    if (!notFound && (validated || workspaceId)) return { ok: false, stderr: r.stderr };
    if (cachedWorkspaceId === ws) cachedWorkspaceId = null;
  }
  const fresh = await listFocusedWorkspace(env);
  if (!fresh || fresh === ws) return { ok: false, stderr: "no workspace id" };
  const r = await send(fresh);
  if (r.ok) cachedWorkspaceId = fresh;
  return { ok: r.ok, stderr: r.stderr };
}

export async function notify(title, body = "", { env = process.env } = {}) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  const r = await runHerdr(args, { env });
  return { ok: r.ok, stderr: r.stderr };
}
