import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHerdr, unwrap } from "./lib/herdr.js";

export const LABEL = "llama-swap";

/** Foreground cmdline looks like our dashboard (or any process rooted in this plugin). */
const DASHBOARD_RE = /(^|[\s\/])src\/cli\.js\s+dashboard|herdr-llama-swap/;

export function pluginRoot(env = process.env) {
  return env.HERDR_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export function dashboardCommand(root) {
  return `cd ${shq(root)} && node ${shq(path.join(root, "src/cli.js"))} dashboard`;
}

const fail = (reason) => ({ ok: false, reason });
const why = (r) => (r.stderr || r.stdout || "herdr failed").trim().split("\n")[0];

async function runInPane(paneId, root, env) {
  const r = await runHerdr(["pane", "run", paneId, dashboardCommand(root)], { env });
  return r.ok ? null : `pane run failed: ${why(r)}`;
}

function toArray(parsed, key) {
  const v = Array.isArray(parsed) ? parsed : parsed?.[key];
  return Array.isArray(v) ? v : [];
}

async function listPanes(env) {
  const r = await runHerdr(["pane", "list"], { env });
  if (!r.ok) return [];
  return toArray(unwrap(r.stdout), "panes");
}

const paneIdOf = (p) => p?.pane_id ?? p?.id ?? null;
const workspaceIdOf = (p) => p?.workspace_id ?? p?.workspace?.workspace_id ?? null;
const paneIndex = (id) => Number(String(id).match(/:p(\d+)$/)?.[1] ?? NaN);

/** Root pane from workspace-list output, else first pane of that workspace from pane list. */
async function resolveRootPane(ex, wid, env) {
  const direct = ex?.root_pane?.pane_id ?? ex?.root_pane_id ?? ex?.focused_pane_id ?? ex?.pane_id;
  if (direct) return direct;
  if (!wid) return null;
  const mine = (await listPanes(env)).filter((p) => workspaceIdOf(p) === wid);
  if (!mine.length) return null;
  if (mine.length === 1) return paneIdOf(mine[0]);
  const ranked = mine
    .map((p, i) => ({ p, i, n: paneIndex(paneIdOf(p)) }))
    .sort((a, b) => (Number.isNaN(a.n) || Number.isNaN(b.n) ? a.i - b.i : a.n - b.n));
  return paneIdOf(ranked[0].p);
}

/** True when the pane foreground process is already the dashboard. Never throws. */
export async function dashboardRunning(paneId, env = process.env) {
  if (!paneId) return false;
  const r = await runHerdr(["pane", "process-info", "--pane", paneId], { env });
  if (!r.ok) return false;
  const j = unwrap(r.stdout);
  const procs = toArray(j?.process_info ?? j, "foreground_processes");
  return procs.some((p) => {
    const argv = Array.isArray(p?.argv) ? p.argv.join(" ") : "";
    return DASHBOARD_RE.test(`${p?.cmdline ?? ""} ${argv}`);
  });
}

/** First *pane_id* string anywhere in the plugin context blob (defensive, bounded). */
function paneIdFromContext(raw) {
  if (!raw) return null;
  let ctx;
  try {
    ctx = JSON.parse(raw);
  } catch {
    return null;
  }
  const seen = new Set();
  let found = null;
  const walk = (node, depth) => {
    if (found || !node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (found) return;
      if (typeof v === "string" && v && /pane_id$/i.test(k)) { found = v; return; }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(ctx, 0);
  return found;
}

/** Target pane for split mode: env -> plugin context -> pane list focused -> workspace match. */
async function resolveSplitPane(env) {
  if (env.HERDR_PANE_ID) return env.HERDR_PANE_ID;
  const fromCtx = paneIdFromContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  if (fromCtx) return fromCtx;
  const panes = await listPanes(env);
  const focused = panes.find((p) => p?.focused === true || p?.is_focused === true || p?.active === true);
  const focusedId = paneIdOf(focused);
  if (focusedId) return focusedId;
  if (env.HERDR_WORKSPACE_ID) {
    const mine = panes.filter((p) => workspaceIdOf(p) === env.HERDR_WORKSPACE_ID);
    const id = paneIdOf(mine[0]);
    if (id) return id;
  }
  return null;
}

/** Open the live dashboard. Resolves {ok, kind, id} or {ok:false, reason}; never throws. */
export async function openDashboard({ target = "workspace", env = process.env } = {}) {
  const root = pluginRoot(env);
  try {
    if (target === "popup") {
      const r = await runHerdr(["plugin", "pane", "open", "--plugin", "llama-swap", "--entrypoint", "dashboard", "--focus"], { env, timeoutMs: 15000 });
      if (!r.ok) return fail(`popup open failed: ${why(r)}`);
      return { ok: true, kind: "popup", id: unwrap(r.stdout)?.pane?.pane_id ?? "popup" };
    }
    if (target === "split") {
      const pane = await resolveSplitPane(env);
      if (!pane) return fail("no focused pane to split");
      const r = await runHerdr(["pane", "split", "--pane", pane, "--direction", "right"], { env });
      if (!r.ok) return fail(`pane split failed: ${why(r)}`);
      const j = unwrap(r.stdout);
      const id = j?.pane?.pane_id ?? j?.pane_id ?? j?.new_pane?.pane_id;
      if (!id) return fail("split succeeded but no pane id in output");
      const e = await runInPane(id, root, env);
      return e ? fail(e) : { ok: true, kind: "pane", id };
    }
    if (target !== "workspace") return fail(`unknown target: ${target}`);

    const l = await runHerdr(["workspace", "list"], { env });
    if (!l.ok) return fail(`workspace list failed: ${why(l)}`);
    const ex = toArray(unwrap(l.stdout), "workspaces").find((w) => w?.label === LABEL);
    if (ex) {
      const wid = ex.workspace_id ?? ex.id;
      const f = await runHerdr(["workspace", "focus", wid], { env });
      if (!f.ok) return fail(`workspace focus failed: ${why(f)}`);
      const pane = await resolveRootPane(ex, wid, env);
      if (!pane) return fail("workspace found but no root pane resolved");
      // The daemon reports workspace tokens every poll, so "no tokens" is NOT a liveness signal.
      // Ask the pane what it is running instead; only (re)start the dashboard when it is gone.
      if (await dashboardRunning(pane, env)) return { ok: true, kind: "workspace", id: wid, pane };
      const e = await runInPane(pane, root, env);
      return e ? fail(e) : { ok: true, kind: "workspace", id: wid, pane };
    }
    const c = await runHerdr(["workspace", "create", "--cwd", root, "--label", LABEL, "--no-focus"], { env });
    if (!c.ok) return fail(`workspace create failed: ${why(c)}`);
    const j = unwrap(c.stdout);
    const pane = j?.root_pane?.pane_id;
    const wid = j?.workspace?.workspace_id;
    if (!pane) return fail("workspace created but no root pane id in output");
    const e = await runInPane(pane, root, env);
    return e ? fail(e) : { ok: true, kind: "workspace", id: wid ?? pane, pane };
  } catch (err) {
    return fail(String(err?.message || err));
  }
}
