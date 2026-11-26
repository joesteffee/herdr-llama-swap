import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfig, statePaths, readJsonFile } from "./lib/config.js";
import { makeClient, collect } from "./lib/poll.js";
import * as herdr from "./lib/herdr.js";

const SELF = fileURLToPath(import.meta.url);

/** Pure: notifications for state transitions. */
export function computeEvents(prev, cur) {
  const events = [];
  if (!prev) return events;
  if (prev.status !== "offline" && cur.status === "offline") {
    events.push({ title: "llama-swap offline", body: cur.lastError || "server unreachable" });
  } else if (prev.status === "offline" && cur.status !== "offline") {
    events.push({ title: "llama-swap back online", body: cur.loaded ? `model: ${cur.loaded}` : "no model loaded" });
  }
  if (prev.status !== "offline" && cur.status !== "offline") {
    if (prev.loaded && cur.loaded && prev.loaded !== cur.loaded) {
      events.push({ title: "llama-swap model changed", body: `${prev.loaded} -> ${cur.loaded}` });
    } else if (prev.loaded && !cur.loaded) {
      events.push({ title: "llama-swap model unloaded", body: `${prev.loaded} is no longer running (crash or unload)` });
    } else if (!prev.loaded && cur.loaded) {
      events.push({ title: "llama-swap model loaded", body: cur.loaded });
    }
    if (cur.lastError && cur.lastError !== prev.lastError) {
      events.push({ title: "llama-swap error", body: cur.lastError.slice(0, 200) });
    }
  }
  return events;
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * One poll cycle: collect, write state.json, report tokens, notify on transitions.
 * Never throws.
 */
export async function pollOnce({ client, prev = null, paths, pollMs = 2000, env = process.env, nowMs = Date.now(), notify = true } = {}) {
  const state = await collect(client, prev, nowMs);
  state.url = client.baseUrl;
  try {
    writeJsonAtomic(paths.state, state);
  } catch (err) {
    console.error(`[llama-swap] cannot write ${paths.state}: ${err.message}`);
  }
  if (notify) {
    for (const ev of computeEvents(prev, state)) await herdr.notify(ev.title, ev.body, { env });
  }
  await herdr.reportTokens(state, { pollMs, env });
  return state;
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function readPid(file) {
  try {
    return parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  } catch {
    return NaN;
  }
}

export function backoffMs(pollMs, failures) {
  if (failures < 3) return pollMs;
  return Math.min(30000, pollMs * 2 ** (failures - 2));
}

async function runLoop({ url } = {}) {
  const cfg = resolveConfig({ url });
  const paths = statePaths();
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.pid, String(process.pid));
  const client = makeClient(cfg.url);
  let stopping = false;
  let wake = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.error(`[llama-swap] daemon pid ${process.pid} polling ${cfg.url} every ${cfg.pollMs}ms`);
  let prev = null;
  let failures = 0;
  let lastLogged = null;
  while (!stopping) {
    let state;
    try {
      state = await pollOnce({ client, prev, paths, pollMs: cfg.pollMs });
      failures = state.status === "offline" ? failures + 1 : 0;
      if (state.lastError && state.lastError !== lastLogged) console.error(`[llama-swap] ${new Date().toISOString()} ${state.lastError}`);
      lastLogged = state.lastError;
      prev = state;
    } catch (err) {
      failures++;
      console.error(`[llama-swap] poll crashed: ${err?.stack || err}`);
    }
    if (stopping) break;
    // NOTE: this timer must stay referenced — with every handle unref'd the
    // event loop empties after the first poll and the daemon silently exits.
    await new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, backoffMs(cfg.pollMs, failures));
    });
    wake = null;
  }
  try {
    if (readPid(paths.pid) === process.pid) fs.unlinkSync(paths.pid);
  } catch {}
  return 0;
}

async function start({ url } = {}) {
  const paths = statePaths();
  const existing = readPid(paths.pid);
  if (isAlive(existing)) {
    console.log(`llama-swap daemon already running (pid ${existing})`);
    return 0;
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  const startedAt = Date.now();
  const out = fs.openSync(paths.log, "a");
  const args = [SELF, "run", ...(url ? ["--url", url] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const s = readJsonFile(paths.state);
    if (s && s.updatedAt > startedAt && isAlive(child.pid)) {
      console.log(`llama-swap daemon started (pid ${child.pid})`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`llama-swap daemon did not produce state within 3s (pid ${child.pid}); see ${paths.log}`);
  return 1;
}

async function stop() {
  const paths = statePaths();
  const pid = readPid(paths.pid);
  if (!isAlive(pid)) {
    try {
      fs.unlinkSync(paths.pid);
    } catch {}
    console.log("llama-swap daemon not running");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid)) {
    console.error(`daemon (pid ${pid}) did not exit`);
    return 1;
  }
  console.log(`llama-swap daemon stopped (pid ${pid})`);
  return 0;
}

function status() {
  const paths = statePaths();
  const pid = readPid(paths.pid);
  const alive = isAlive(pid);
  const s = readJsonFile(paths.state);
  console.log(alive ? `daemon: running (pid ${pid})` : "daemon: not running");
  console.log(`state file: ${paths.state}`);
  console.log(`log file: ${paths.log}`);
  if (s) console.log(`last state: ${s.status}, model=${s.loaded ?? "none"}, phase=${s.phase}, age=${Math.round((Date.now() - s.updatedAt) / 1000)}s`);
  return alive ? 0 : 1;
}

async function once({ url } = {}) {
  const cfg = resolveConfig({ url });
  const paths = statePaths();
  const prevFile = readJsonFile(paths.state);
  const state = await pollOnce({ client: makeClient(cfg.url), prev: prevFile, paths, pollMs: cfg.pollMs, notify: false });
  console.log(JSON.stringify(state, null, 2));
  return 0;
}

export async function main(argv) {
  const urlIdx = argv.indexOf("--url");
  const url = urlIdx >= 0 ? argv[urlIdx + 1] : undefined;
  const sub = argv.find((a, i) => !a.startsWith("--") && (urlIdx < 0 || i !== urlIdx + 1));
  switch (sub) {
    case "start": return start({ url });
    case "stop": return stop();
    case "status": return status();
    case "run": return runLoop({ url });
    case "once": return once({ url });
    default:
      console.error("usage: daemon start|stop|status|run|once [--url URL]");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
