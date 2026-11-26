import { LlamaSwapClient } from "./client.js";
import { deriveState } from "./state.js";

/** One full poll of the HTTP API. Never throws; failures become offline/degraded state. */
export async function collect(client, prev = null, nowMs = Date.now()) {
  try {
    await client.health();
  } catch (err) {
    return deriveState({ online: false, prev, nowMs, error: err.message });
  }
  const errors = [];
  const attempt = async (p, fallback) => {
    try {
      return await p;
    } catch (err) {
      errors.push(err.message);
      return fallback;
    }
  };
  const [models, running, metrics] = await Promise.all([
    attempt(client.models(), []),
    attempt(client.running(), []),
    attempt(client.metrics(), null),
  ]);
  const slots = running[0] ? await attempt(client.slots(running[0].model), []) : [];
  return deriveState({ online: true, models, running, slots, metrics, prev, nowMs, error: errors[0] ?? null });
}

export function makeClient(url, opts) {
  return new LlamaSwapClient(url, opts);
}
