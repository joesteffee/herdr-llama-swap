import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHerdr, unwrap } from "./lib/herdr.js";

export const LABEL = "llama-swap";

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
      const r = await runHerdr(["pane", "split", "--current", "--direction", "right"], { env });
      if (!r.ok) return fail(`no focused pane to split: ${why(r)}`);
      const j = unwrap(r.stdout);
      const id = j?.pane?.pane_id ?? j?.pane_id ?? j?.new_pane?.pane_id;
      if (!id) return fail("split succeeded but no pane id in output");
      const e = await runInPane(id, root, env);
      return e ? fail(e) : { ok: true, kind: "pane", id };
    }
    if (target !== "workspace") return fail(`unknown target: ${target}`);

    const l = await runHerdr(["workspace", "list"], { env });
    if (!l.ok) return fail(`workspace list failed: ${why(l)}`);
    const list = unwrap(l.stdout)?.workspaces;
    const ex = Array.isArray(list) ? list.find((w) => w?.label === LABEL) : null;
    if (ex) {
      const wid = ex.workspace_id ?? ex.id;
      const f = await runHerdr(["workspace", "focus", wid], { env });
      if (!f.ok) return fail(`workspace focus failed: ${why(f)}`);
      const empty = !ex.tokens || Object.keys(ex.tokens).length === 0;
      const pane = ex.root_pane?.pane_id ?? ex.root_pane_id ?? ex.focused_pane_id ?? ex.pane_id;
      if (empty && pane) {
        const e = await runInPane(pane, root, env);
        if (e) return fail(e);
      }
      return { ok: true, kind: "workspace", id: wid };
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
