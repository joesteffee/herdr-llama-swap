import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pluginRoot } from "./open.js";
import { unwrap } from "./lib/herdr.js";

const NAME = "llama-swap";
const DASH_RE = /src\/cli\.js\s+dashboard/;

export function herdrCoreBin(env = process.env) {
  return env.HERDR_CORE_BIN || "herdr-core";
}

/** Run herdr-core (NOT herdr); NEVER throws. Resolves {ok, stdout, stderr}. */
export function runHerdrCore(args, { env = process.env, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(herdrCoreBin(env), args, { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, stdout: String(stdout || ""), stderr: String(stderr || err.message) });
        else resolve({ ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: String(err?.message || err) });
    }
  });
}

/** One JSON-RPC request through `herdr-core connect`. NEVER throws. Resolves {ok, reply?, stderr}. */
export function rpc(id, method, params, { env = process.env, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(herdrCoreBin(env), ["connect"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, stderr: "herdr-core connect timed out" }); }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.stdin.on("error", () => {});
      child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, stderr: String(e?.message || e) }); });
      child.on("close", () => {
        clearTimeout(timer);
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j && typeof j === "object" && !Array.isArray(j)) return finish({ ok: true, reply: j, stderr: err });
          } catch {}
        }
        finish({ ok: false, stderr: err.trim() || "no JSON reply from herdr-core connect" });
      });
      child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } catch (e) {
      finish({ ok: false, stderr: String(e?.message || e) });
    }
  });
}

const oneLine = (s) => String(s || "").trim().split("\n")[0].slice(0, 300);

function isDashboard(info) {
  if (!info || typeof info !== "object") return false;
  const argv = Array.isArray(info.foreground?.argv) ? info.foreground.argv : info.argv;
  return Array.isArray(argv) && DASH_RE.test(argv.join(" "));
}

/** Ensure a live herdr-core terminal named llama-swap runs the dashboard. -> {ok,id} | {ok:false,reason} */
async function ensureTerminal(env, root) {
  const ls = await runHerdrCore(["ls", "--json"], { env });
  if (!ls.ok) return { ok: false, reason: `herdr-core ls failed: ${oneLine(ls.stderr)}` };
  const parsed = unwrap(ls.stdout);
  const list = Array.isArray(parsed?.terminals) ? parsed.terminals : Array.isArray(parsed) ? parsed : null;
  if (!list) return { ok: false, reason: "herdr-core ls --json: unexpected output" };
  const named = list.filter((t) => t && t.name === NAME && t.address);
  const stale = [];
  for (const t of named) {
    if (t.state === "live") {
      const g = await runHerdrCore(["get", t.address], { env });
      if (g.ok && isDashboard(unwrap(g.stdout))) return { ok: true, id: t.address };
      // live but not the dashboard: rm only removes finished terminals, so end it first (failures ignored)
      await runHerdrCore(["kill", t.address], { env });
    }
    stale.push(t.address);
  }
  // names must be unique among live terminals: remove old ones BEFORE running a new one
  for (const addr of stale) await runHerdrCore(["rm", addr], { env });
  const r = await runHerdrCore(
    ["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", NAME, "--cwd", root, "node", `${root}/src/cli.js`, "dashboard"],
    { env },
  );
  if (!r.ok) return { ok: false, reason: `herdr-core run failed: ${oneLine(r.stderr || r.stdout)}` };
  let id = unwrap(r.stdout)?.address;
  if (!id) {
    const ls2 = await runHerdrCore(["ls", "--json"], { env });
    const p2 = ls2.ok ? unwrap(ls2.stdout) : null;
    const l2 = Array.isArray(p2?.terminals) ? p2.terminals : Array.isArray(p2) ? p2 : [];
    id = l2.find((t) => t && t.name === NAME && t.state === "live" && t.address)?.address;
  }
  if (!id) return { ok: false, reason: "herdr-core run: no address in output" };
  return { ok: true, id };
}

function firstBlock(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "block" && node.content && typeof node.content === "object") return node;
  for (const c of Array.isArray(node.children) ? node.children : []) {
    const b = firstBlock(c);
    if (b) return b;
  }
  return null;
}

/** Pure: point (or create) the llama-swap tab in spaces[0] at terminal addr. -> {ok,value,tab} | {ok:false,reason} */
export function applyTab(value, addr, rand = () => randomBytes(16).toString("hex")) {
  const v = structuredClone(value);
  const space = Array.isArray(v?.spaces) ? v.spaces[0] : null;
  if (!space || typeof space !== "object") return { ok: false, reason: "herdr-app document has no spaces[0]" };
  if (!Array.isArray(space.tabs)) return { ok: false, reason: "herdr-app spaces[0] has no tabs array" };
  const existing = space.tabs.find((t) => t && t.name === NAME);
  if (existing) {
    const b = firstBlock(existing.root);
    if (!b) return { ok: false, reason: `tab "${NAME}" has no terminal block` };
    b.content.terminal = addr;
    return { ok: true, value: v, tab: existing.id };
  }
  const tabId = "tb" + rand();
  const paneId = "pb" + rand();
  space.tabs.unshift({
    id: tabId,
    name: NAME,
    root: { type: "row", id: tabId, children: [{ type: "block", id: paneId, content: { terminal: addr } }] },
  });
  return { ok: true, value: v, tab: tabId };
}

let rpcId = 0;
async function syncTab(env, addr) {
  let lastReason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = await rpc(++rpcId, "doc.get", { name: "herdr-app" }, { env });
    if (!g.ok) return { ok: false, reason: `doc.get failed: ${oneLine(g.stderr)}` };
    if (g.reply.error) return { ok: false, reason: `doc.get error: ${oneLine(JSON.stringify(g.reply.error))}` };
    const res = unwrap(JSON.stringify(g.reply));
    if (!res || typeof res !== "object" || !res.value || typeof res.value !== "object") return { ok: false, reason: "doc.get: unexpected reply" };
    const a = applyTab(res.value, addr);
    if (!a.ok) return a;
    const s = await rpc(++rpcId, "doc.set", { name: "herdr-app", value: a.value, version: res.version }, { env });
    if (s.ok && !s.reply.error) return { ok: true, tab: a.tab };
    lastReason = s.ok ? `doc.set error: ${oneLine(JSON.stringify(s.reply.error))}` : `doc.set failed: ${oneLine(s.stderr)}`;
  }
  return { ok: false, reason: lastReason };
}

/** Open the dashboard as a herdr-core app tab. NEVER throws. */
export async function openHcTab({ env = process.env } = {}) {
  try {
    const root = pluginRoot(env);
    const t = await ensureTerminal(env, root);
    if (!t.ok) return t;
    const s = await syncTab(env, t.id);
    if (!s.ok) return s;
    return { ok: true, kind: "hc-tab", id: t.id, tab: s.tab };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
