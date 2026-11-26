#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./lib/config.js";
import { makeClient, collect } from "./lib/poll.js";
import { dashboard, fmtDuration } from "./dashboard.js";
import { main as daemonMain } from "./daemon.js";
import { openDashboard } from "./open.js";
import { openHcTab } from "./hctab.js";

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

const HELP = `herdr-llama-swap ${pkg.version} — monitor/control a remote llama-swap server

Usage: herdr-llama-swap <command> [options]

Commands:
  status [--json]            one poll, human-readable (or JSON)
  once                       alias of status
  models                     list models and load state
  dashboard [--once]         live TUI (snapshot with --once or when not a TTY)
  open [--target T]          open live dashboard. Default: hc (herdr-core tab in the "status" space,
                             visible in the Herdr desktop app). Others: --target workspace | --target split
                             | --target popup (herdr-server panes; desktop app does not show them); hc-tab = hc.
                             Env LLAMASWAP_OPEN_TARGET sets the default when no --target is given.
  daemon start|stop|status|run|once
  unload <id> [--yes]        unload a currently loaded model
  pause [--yes]              pause llama-swap
  resume [--yes]             resume llama-swap

Global options: --url URL, --json, --yes, --help, --version
Exit codes: 0 ok, 1 failure, 2 usage error
`;

export function parseArgs(argv) {
  const o = { _: [], json: false, yes: false, once: false, help: false, version: false, url: undefined, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--once") o.once = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--version" || a === "-v") o.version = true;
    else if (a === "--url") { o.url = argv[++i]; if (!o.url) o.bad = "--url needs a value"; }
    else if (a.startsWith("--url=")) o.url = a.slice(6);
    else if (a === "--target") { o.target = argv[++i]; if (!o.target) o.bad = "--target needs a value"; }
    else if (a.startsWith("--target=")) o.target = a.slice(9);
    else o._.push(a);
  }
  return o;
}

export function formatStatus(s) {
  const L = [`llama-swap ${s.url ?? ""}: ${s.status}`];
  if (s.status === "offline") {
    L.push(`  error: ${s.lastError ?? "unreachable"}`);
    return L.join("\n");
  }
  L.push(`  model: ${s.loaded ?? "(none)"}${s.modelName ? ` (${s.modelName})` : ""}`);
  L.push(`  phase: ${s.phase}`);
  const t = (v) => (v == null ? "-" : v.toFixed(1));
  L.push(`  decode: ${t(s.rates.decodeTps)} tok/s  prompt: ${t(s.rates.promptTps)} tok/s`);
  if (s.context.nCtx) L.push(`  context: ${s.context.promptTokens ?? 0}/${s.context.nCtx}`);
  if (s.gpu) {
    const g = (b) => (b / 1024 ** 3).toFixed(1);
    L.push(`  gpu: util ${s.gpu.utilPercent ?? "-"}%  temp ${s.gpu.tempC ?? "-"}C  vram ${g(s.gpu.vramUsedBytes)}/${g(s.gpu.vramTotalBytes)} GiB`);
  }
  if (s.host) L.push(`  host: ram ${(s.host.memUsedBytes / 1024 ** 3).toFixed(1)}/${(s.host.memTotalBytes / 1024 ** 3).toFixed(1)} GiB  cpu ${s.host.cpuPercentAvg?.toFixed(0) ?? "-"}%`);
  if (s.ttlSec != null) L.push(`  ttl: ${fmtDuration(s.ttlSec)}`);
  if (s.lastError) L.push(`  warning: ${s.lastError}`);
  return L.join("\n");
}

async function confirmTty(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question + " [y/N] ", r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function gate(o, what) {
  console.error(`About to: ${what}`);
  if (o.yes) return true;
  if (!process.stdin.isTTY) {
    console.error("Refusing without --yes (stdin is not a TTY)");
    return false;
  }
  return confirmTty("Proceed?");
}

export async function run(argv) {
  const o = parseArgs(argv);
  if (o.bad) { console.error(o.bad); return 2; }
  if (o.version) { console.log(pkg.version); return 0; }
  const [cmd, ...rest] = o._;
  if (o.help || !cmd) { (cmd || o.help ? console.log : console.error)(HELP); return cmd || o.help ? 0 : 2; }
  const cfg = resolveConfig({ url: o.url });
  const client = makeClient(cfg.url);

  try {
    switch (cmd) {
      case "status":
      case "once": {
        const s = await collect(client);
        s.url = cfg.url;
        console.log(o.json ? JSON.stringify(s, null, 2) : formatStatus(s));
        return s.status === "offline" ? 1 : 0;
      }
      case "models": {
        const [models, running] = await Promise.all([client.models(), client.running()]);
        const live = new Set(running.map((r) => r.model));
        if (o.json) console.log(JSON.stringify(models.map((m) => ({ ...m, running: live.has(m.id) })), null, 2));
        else for (const m of models) console.log(`${live.has(m.id) ? "*" : " "} ${m.id}\t${m.status?.value ?? "?"}\t${m.name ?? ""}`);
        return 0;
      }
      case "dashboard":
        return await dashboard({ url: o.url, once: o.once });
      case "open": {
        const TARGETS = ["workspace", "split", "popup", "hc"];
        const envT = process.env.LLAMASWAP_OPEN_TARGET === "hc-tab" ? "hc" : process.env.LLAMASWAP_OPEN_TARGET;
        let target = o.target ?? (TARGETS.includes(envT) ? envT : "hc");
        if (target === "hc-tab") target = "hc";
        if (!TARGETS.includes(target)) { console.error("--target must be workspace|split|popup|hc|hc-tab"); return 2; }
        const r = target === "hc" ? await openHcTab({}) : await openDashboard({ target });
        if (!r.ok) { console.error(r.reason); return 1; }
        console.log(o.json ? JSON.stringify(r) : r.id);
        return 0;
      }
      case "daemon":
        return await daemonMain([...rest, ...(o.url ? ["--url", o.url] : [])]);
      case "unload": {
        const id = rest[0];
        if (!id) { console.error("usage: unload <model-id>"); return 2; }
        const running = await client.running();
        if (!running.some((r) => r.model === id)) {
          console.error(`Model "${id}" is not currently loaded (loaded: ${running.map((r) => r.model).join(", ") || "none"})`);
          return 1;
        }
        if (!(await gate(o, `unload ${id} on ${cfg.url}`))) return 1;
        await client.unload(id);
        console.log(`unloaded ${id}`);
        return 0;
      }
      case "pause":
      case "resume": {
        if (!(await gate(o, `${cmd} llama-swap at ${cfg.url}`))) return 1;
        await client[cmd]();
        console.log(`${cmd}: ok`);
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.error(HELP);
        return 2;
    }
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
