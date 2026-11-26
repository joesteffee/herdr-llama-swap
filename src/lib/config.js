import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const DEFAULT_URL = "https://llama-swap.int.somewhat.me";
export const DEFAULT_POLL_MS = 2000;
export const MIN_POLL_MS = 500;

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve endpoint + poll interval: --url, $LLAMASWAP_URL, config.json, default. */
export function resolveConfig({ url, pollMs, env = process.env } = {}) {
  const file = env.HERDR_PLUGIN_CONFIG_DIR ? readJsonFile(path.join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json")) : null;
  const cfg = file && typeof file === "object" ? file : {};
  const resolvedUrl = String(url || env.LLAMASWAP_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, "");
  let poll = Number(pollMs ?? env.LLAMASWAP_POLL_MS ?? cfg.pollMs ?? DEFAULT_POLL_MS);
  if (!Number.isFinite(poll)) poll = DEFAULT_POLL_MS;
  return { url: resolvedUrl, pollMs: Math.max(MIN_POLL_MS, Math.round(poll)) };
}

export function stateDir(env = process.env) {
  if (env.HERDR_PLUGIN_STATE_DIR) return env.HERDR_PLUGIN_STATE_DIR;
  const base = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state");
  return path.join(base, "herdr-llama-swap");
}

export function statePaths(env = process.env) {
  const dir = stateDir(env);
  return {
    dir,
    state: path.join(dir, "state.json"),
    pid: path.join(dir, "daemon.pid"),
    log: path.join(dir, "daemon.log"),
  };
}
