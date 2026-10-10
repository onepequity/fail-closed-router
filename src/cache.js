/**
 * Content-addressed answer cache.
 *
 * The key covers every input that shapes an answer: lane, the lane's routes
 * (provider, model, decoding settings), system prompt, user prompt and schema.
 * Credentials are never part of the key. A changed input is a new key.
 *
 * Every served answer is stored, including answers the validator rejected, so
 * a replay takes the same path as the original run. A call that throws is
 * never stored.
 */

export const CACHE_KEY_VERSION = "fcr-answer-v1";

/** JSON.stringify with sorted object keys, so equal values hash equally. */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/** Hex SHA-256 using Web Crypto (Node 20+, Deno, Bun, edge runtimes). */
export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function answerKey({ lane, routes = [], system = null, prompt = "", schema = null, schemaName = null, strict = true }) {
  return sha256Hex(canonicalJson({
    v: CACHE_KEY_VERSION,
    lane,
    routes: routes.map((route) => [route.provider, route.model, route.temperature ?? null, route.maxOutputTokens ?? null, route.baseUrl ?? null]),
    system: system == null ? null : String(system),
    prompt: String(prompt ?? ""),
    schema: schema ?? null,
    schemaName: schema ? schemaName : null,
    strict: schema ? strict : null
  }));
}

/**
 * In-memory cache. Optional `maxEntries` evicts the oldest entry first.
 * @param {{ maxEntries?: number }} [options]
 */
export function memoryCache({ maxEntries = Infinity } = {}) {
  const store = new Map();
  return {
    get(key) {
      return store.has(key) ? structuredClone(store.get(key)) : undefined;
    },
    set(key, value) {
      store.delete(key);
      store.set(key, structuredClone(value));
      while (store.size > maxEntries) store.delete(store.keys().next().value);
    },
    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    }
  };
}
