import readline from "node:readline";
import { resolveConfig } from "./lib/config.js";
import { makeClient, collect } from "./lib/poll.js";

const ESC = "\x1b[";
const c = {
  reset: ESC + "0m", bold: ESC + "1m", dim: ESC + "2m",
  red: ESC + "31m", green: ESC + "32m", yellow: ESC + "33m", cyan: ESC + "36m", inv: ESC + "7m",
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GIB = 1024 ** 3;

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

export function bar(frac, width = 24, color = true) {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const n = Math.round(f * width);
  const col = f > 0.9 ? c.red : f > 0.7 ? c.yellow : c.green;
  const body = "█".repeat(n) + "░".repeat(width - n);
  return color ? `${col}${body}${c.reset}` : body;
}
const pct = (v) => (v == null ? "-" : `${v.toFixed(0)}%`);
const num = (v, d = 1) => (v == null ? "-" : v.toFixed(d));
const gib = (b) => (b == null ? "-" : (b / GIB).toFixed(1));

export function fmtDuration(sec) {
  if (sec == null) return "-";
  sec = Math.max(0, Math.round(sec));
  return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
}

/** Pure renderer: returns lines of text. opts: url, toast, menu, confirm, spin, idleSec, color. */
export function render(state, opts = {}) {
  const color = opts.color !== false;
  const k = (code, s) => (color ? code + s + c.reset : s);
  const L = [];
  const st = state?.status ?? "offline";
  const stCol = st === "online" ? c.green : st === "degraded" ? c.yellow : c.red;
  L.push(`${k(c.bold, "llama-swap")}  ${opts.url ?? state?.url ?? ""}  [${k(stCol, st.toUpperCase())}]`);
  L.push("");
  if (!state || st === "offline") {
    L.push(k(c.red, "Server unreachable") + (state?.lastError ? `: ${state.lastError}` : ""));
  } else {
    const spin = SPIN[(opts.spin ?? 0) % SPIN.length];
    L.push(`Model   ${state.loaded ? k(c.cyan, state.loaded) : k(c.dim, "(none loaded)")}${state.modelName ? `  ${state.modelName}` : ""}`);
    const busy = state.phase === "loading" || state.phase === "swapping";
    L.push(`Phase   ${busy ? spin + " " : ""}${state.phase}`);
    L.push(`Decode  ${num(state.rates.decodeTps)} tok/s    Prompt  ${num(state.rates.promptTps)} tok/s`);
    const x = state.context;
    if (x.nCtx) {
      const used = x.promptTokens ?? 0;
      L.push(`Context ${bar(used / x.nCtx, 24, color)} ${used}/${x.nCtx} (${((used / x.nCtx) * 100).toFixed(1)}%)  cache ${x.cacheTokens ?? "-"}  decoded ${x.nDecoded ?? "-"}`);
    } else {
      L.push("Context -");
    }
    L.push("");
    const g = state.gpu;
    if (g) {
      L.push(`GPU     util ${pct(g.utilPercent)}  temp ${num(g.tempC, 0)}°C  fan ${pct(g.fanPercent)}  power ${num(g.powerW, 0)}W`);
      L.push(`VRAM    ${bar((g.vramUsedBytes ?? 0) / (g.vramTotalBytes || 1), 24, color)} ${gib(g.vramUsedBytes)}/${gib(g.vramTotalBytes)} GiB`);
    } else L.push("GPU     -");
    const h = state.host;
    if (h) {
      L.push(`RAM     ${bar((h.memUsedBytes ?? 0) / (h.memTotalBytes || 1), 24, color)} ${gib(h.memUsedBytes)}/${gib(h.memTotalBytes)} GiB  cpu ${pct(h.cpuPercentAvg)}`);
    } else L.push("RAM     -");
    if (state.ttlSec != null) {
      const idle = opts.idleSec;
      L.push(idle == null ? `TTL     ${fmtDuration(state.ttlSec)} idle timeout` : `TTL     unloads in ${fmtDuration(state.ttlSec - idle)} if idle (timeout ${fmtDuration(state.ttlSec)})`);
    }
  }
  if (opts.menu) {
    L.push("", k(c.bold, "Switch model (warm-up request) — ↑/↓ select, Enter, Esc cancel"));
    opts.menu.items.forEach((m, i) => L.push(`${i === opts.menu.index ? k(c.inv, "> " + m) : "  " + m}`));
    if (!opts.menu.items.length) L.push("  (no other models)");
  }
  if (opts.confirm) L.push("", k(c.yellow, opts.confirm));
  if (opts.toast) L.push("", opts.toast);
  if (opts.keys !== false) L.push("", k(c.dim, "[r]efresh [l]switch [u]nload [p]ause [R]esume [q]uit"));
  return L;
}

async function runTui({ url, pollMs }) {
  const client = makeClient(url);
  const out = process.stdout;
  let state = null, models = [], toast = "", toastAt = 0, spin = 0;
  let menu = null, confirm = null, busy = false, lastActive = Date.now(), closed = false;

  const draw = () => {
    if (closed) return;
    const idleSec = state?.phase === "idle" ? (Date.now() - lastActive) / 1000 : null;
    const lines = render(state, {
      url, spin, idleSec, menu,
      confirm: confirm?.text,
      toast: Date.now() - toastAt < 8000 ? toast : "",
    });
    out.write(ESC + "H" + ESC + "2J" + lines.join("\r\n"));
  };
  const say = (t) => { toast = t; toastAt = Date.now(); draw(); };
  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      state = await collect(client, state);
      if (state.phase !== "idle") lastActive = Date.now();
      if (state.status !== "offline") {
        try { models = await client.models(); } catch {}
      }
    } finally { busy = false; }
    draw();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { process.stdin.setRawMode?.(false); } catch {}
    out.write(ESC + "?25h" + ESC + "?1049l");
  };
  const quit = (code = 0) => { cleanup(); process.exit(code); };
  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  process.on("uncaughtException", (e) => { cleanup(); console.error(e); process.exit(1); });
  process.on("exit", cleanup);

  out.write(ESC + "?1049h" + ESC + "?25l");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.on("resize", draw);

  const requireOnline = () => {
    if (!state || state.status === "offline") { say("Server is offline — action disabled"); return false; }
    return true;
  };
  const act = async (label, fn) => {
    say(`${label}...`);
    try { await fn(); say(`${label}: OK`); } catch (e) { say(`${label} failed: ${e.message.slice(0, 160)}`); }
    refresh();
  };

  process.stdin.on("keypress", (str, key = {}) => {
    if (key.ctrl && key.name === "c") return quit(0);
    if (confirm) {
      const yes = key.name === "return" || str === "y";
      const fn = confirm.fn;
      confirm = null;
      if (yes) fn(); else say("Cancelled");
      return draw();
    }
    if (menu) {
      if (key.name === "up") menu.index = Math.max(0, menu.index - 1);
      else if (key.name === "down") menu.index = Math.min(menu.items.length - 1, menu.index + 1);
      else if (key.name === "escape") menu = null;
      else if (key.name === "return" && menu.items.length) {
        const id = menu.items[menu.index];
        menu = null;
        confirm = {
          text: `Switch (warm-up request) to ${id}? Press Enter/y to confirm, any other key to cancel.`,
          fn: () => act(`Switch to ${id}`, () => client.warmUp(id)),
        };
      }
      return draw();
    }
    if (str === "q") return quit(0);
    if (str === "r") return void refresh();
    if (str === "l") {
      if (!requireOnline()) return;
      const items = models.filter((m) => m.id !== state.loaded).map((m) => m.id);
      menu = { items, index: 0 };
      return draw();
    }
    if (str === "u") {
      if (!requireOnline()) return;
      if (!state.loaded) return say("No model is loaded");
      const id = state.loaded;
      confirm = { text: `Unload ${id}? (y/N)`, fn: () => act(`Unload ${id}`, () => client.unload(id)) };
      return draw();
    }
    if (str === "p") { if (requireOnline()) act("Pause", () => client.pause()); return; }
    if (str === "R") { if (requireOnline()) act("Resume", () => client.resume()); return; }
  });

  setInterval(() => { spin++; draw(); }, 120).unref();
  setInterval(refresh, pollMs).unref();
  await refresh();
  await new Promise(() => {});
}

export async function dashboard({ url, once = false, color } = {}) {
  const cfg = resolveConfig({ url });
  if (once || !process.stdout.isTTY || !process.stdin.isTTY) {
    const state = await collect(makeClient(cfg.url));
    console.log(render(state, { url: cfg.url, color: color ?? process.stdout.isTTY === true, keys: false }).join("\n"));
    return 0;
  }
  return runTui(cfg);
}
