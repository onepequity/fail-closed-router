import { classifyProviderFailure, classifyStatus, isFallbackEligible, redact } from "./classify.js";
import { builtinTransports, routeCapabilities } from "./transports.js";
import { answerKey } from "./cache.js";

/** Raised when a lane stops (fail-closed) or runs out of routes. */
export class RouterError extends Error {
  constructor(message, { attempts = [], failureClass = null } = {}) {
    super(message);
    this.name = "RouterError";
    this.attempts = attempts;
    this.failureClass = failureClass;
  }
}

/** Raised by createRouter when configuration or the lock is invalid. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A classified provider failure. `message` is already redacted. */
export class ProviderError extends Error {
  constructor(message, { status, failureClass } = {}) {
    super(message);
    this.name = "ProviderError";
    if (status !== undefined) this.status = status;
    if (failureClass) this.failureClass = failureClass;
  }
}

const DEFAULT_RETRY = Object.freeze({ maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 15_000 });

/**
 * A leg is pinned when the router can enforce both decoding pins on it:
 * temperature 0 and a strict JSON schema response format. That needs a schema
 * on the call, `temperature: 0` on the route, and a transport whose
 * capabilities include both `temperature` and `jsonSchema`. `pinned: false`
 * opts a route out.
 *
 * @param {object} route
 * @param {object|null} schema JSON Schema for the call
 * @param {{ transport?: object, strict?: boolean }} [options]
 */
export function isPinnedRoute(route, schema, { transport, strict = true } = {}) {
  if (!route || route.pinned === false || !schema || strict === false) return false;
  const caps = routeCapabilities(route, transport ?? builtinTransports[route.provider]);
  return caps.jsonSchema && caps.temperature && route.temperature === 0;
}

function laneKey(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return `${entry[0]}:${entry[1]}`;
  return `${entry?.provider}:${entry?.model}`;
}

/**
 * Check that every lane matches its expected fallback order exactly, and that
 * the lock and the lanes cover the same set of lanes.
 * Lock entries may be "provider:model", [provider, model] or { provider, model }.
 */
export function validateLock(lanes, lock) {
  const names = new Set([...Object.keys(lanes), ...Object.keys(lock)]);
  for (const lane of names) {
    if (!Object.hasOwn(lock, lane)) throw new ConfigError(`${lane}: lane is not covered by the lock`);
    if (!Object.hasOwn(lanes, lane)) throw new ConfigError(`${lane}: locked lane is missing from the configuration`);
    const expected = lock[lane].map(laneKey);
    const actual = lanes[lane].map(laneKey);
    if (expected.join("|") !== actual.join("|")) {
      throw new ConfigError(`${lane}: fallback order drift (expected ${expected.join(", ")}; got ${actual.join(", ")})`);
    }
  }
  return true;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProviderError(`timed out after ${timeoutMs}ms`, { failureClass: "timeout" })), timeoutMs);
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function retryAfterMs(response, now) {
  const header = response.headers?.get?.("retry-after");
  if (header == null || header === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

async function readText(response) {
  try {
    return String(await response.text());
  } catch {
    return "";
  }
}

function parseContent(provider, parsed) {
  if (parsed && Object.hasOwn(parsed, "data")) return parsed.data;
  const content = parsed?.content;
  if (!content) {
    if (parsed?.refusal) throw new ProviderError(`${provider} model refused: ${String(parsed.refusal).slice(0, 200)}`, { failureClass: "model_refusal" });
    throw new ProviderError(`${provider} returned no content`, { failureClass: "malformed_output" });
  }
  const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError(`${provider} returned malformed JSON`, { failureClass: "malformed_output" });
  }
}

/**
 * Create a router.
 *
 * @param {object} options
 * @param {Record<string, object[]>} options.lanes  ordered routes per lane
 * @param {Record<string, Array<string|[string,string]|{provider:string,model:string}>>} [options.lock]
 * @param {{ get(key:string):any, set(key:string, value:any):any }} [options.cache]
 * @param {typeof fetch} [options.fetch]
 * @param {Record<string, object>} [options.transports]  extra or replacement transports
 * @param {Record<string, string|undefined>} [options.env]  source for `credentialEnv`
 * @param {number} [options.timeoutMs]  per request, default 60000
 * @param {{ maxRetries?: number, baseDelayMs?: number, maxDelayMs?: number }} [options.retry]  429 handling
 * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [options.sleep]  test hook
 */
export function createRouter({ lanes, lock, cache = null, fetch: fetchImpl, transports = {}, env, timeoutMs = 60_000, retry = {}, sleep = abortableSleep, now = Date.now } = {}) {
  if (!lanes || typeof lanes !== "object" || Object.keys(lanes).length === 0) throw new ConfigError("lanes must be a non-empty object");
  const allTransports = { ...builtinTransports, ...transports };
  const retryPolicy = { ...DEFAULT_RETRY, ...retry };
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);

  const frozenLanes = {};
  for (const [lane, routes] of Object.entries(lanes)) {
    if (!Array.isArray(routes) || routes.length === 0) throw new ConfigError(`${lane}: a lane needs at least one route`);
    frozenLanes[lane] = Object.freeze(routes.map((route, index) => {
      const where = `${lane}[${index}]`;
      if (!route || typeof route.provider !== "string" || typeof route.model !== "string") throw new ConfigError(`${where}: provider and model are required`);
      const transport = allTransports[route.provider];
      if (!transport) throw new ConfigError(`${where}: no transport registered for provider "${route.provider}"`);
      if (typeof transport.call !== "function" && (typeof transport.buildRequest !== "function" || typeof transport.parseResponse !== "function")) {
        throw new ConfigError(`${where}: transport "${route.provider}" needs call() or buildRequest() and parseResponse()`);
      }
      if (route.pinned === true && !isPinnedRoute(route, {}, { transport })) {
        throw new ConfigError(`${where}: pinned requires temperature 0 and a transport that enforces temperature and JSON schema`);
      }
      return Object.freeze({ ...route });
    }));
  }
  if (lock) validateLock(frozenLanes, lock);
  if (typeof doFetch !== "function") {
    const needsFetch = Object.values(frozenLanes).flat().some((route) => typeof allTransports[route.provider].call !== "function");
    if (needsFetch) throw new ConfigError("no fetch implementation available; pass options.fetch");
  }

  async function resolveApiKey(route) {
    if (typeof route.apiKey === "function") {
      const value = await route.apiKey();
      if (value) return String(value);
    } else if (typeof route.apiKey === "string" && route.apiKey) {
      return route.apiKey;
    }
    const names = route.credentialEnv == null ? [] : [].concat(route.credentialEnv);
    // The one place the library reads the environment, and only for names the route lists.
    const source = env ?? globalThis.process?.env ?? {};
    for (const name of names) if (source[name]) return String(source[name]);
    const hint = names.length ? ` (${names.join(" or ")})` : "";
    throw new ProviderError(`${route.provider} credential is unavailable${hint}`, { failureClass: "authentication" });
  }

  async function fetchWithRetry(provider, request, signal, requestTimeoutMs) {
    for (let attempt = 0; ; attempt += 1) {
      const link = linkedSignal(signal, requestTimeoutMs);
      let response;
      try {
        response = await doFetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: link.signal });
      } finally {
        link.done();
      }
      if (response.ok) return response;
      const text = await readText(response);
      const failureClass = classifyStatus(response.status, text);
      if (response.status === 429 && failureClass === "rate_limit" && attempt < retryPolicy.maxRetries) {
        const hinted = retryAfterMs(response, now);
        const delay = hinted ?? Math.min(retryPolicy.baseDelayMs * 2 ** attempt, retryPolicy.maxDelayMs);
        if (delay <= retryPolicy.maxDelayMs) {
          await sleep(delay, signal);
          continue;
        }
      }
      throw new ProviderError(`${provider} returned ${response.status}: ${text.slice(0, 300)}`, { status: response.status, failureClass });
    }
  }

  async function callRoute(route, ctx) {
    const transport = allTransports[route.provider];
    const capabilities = routeCapabilities(route, transport);
    let apiKey = null;
    try {
      apiKey = await resolveApiKey(route);
      const input = { route, apiKey, prompt: ctx.prompt, system: ctx.system, schema: ctx.schema, schemaName: ctx.schemaName, strict: ctx.strict, capabilities };
      let parsed;
      if (typeof transport.call === "function") {
        const link = linkedSignal(ctx.signal, ctx.timeoutMs);
        try {
          parsed = await transport.call({ ...input, signal: link.signal, fetch: doFetch });
        } finally {
          link.done();
        }
      } else {
        const response = await fetchWithRetry(route.provider, transport.buildRequest(input), ctx.signal, ctx.timeoutMs);
        let json;
        try {
          json = await response.json();
        } catch {
          throw new ProviderError(`${route.provider} returned a non-JSON response envelope`, { failureClass: "provider_unavailable" });
        }
        parsed = transport.parseResponse(json);
      }
      return { data: parseContent(route.provider, parsed), usage: parsed?.usage ?? null };
    } catch (error) {
      const failureClass = ctx.signal?.aborted ? "aborted" : classifyProviderFailure(error);
      throw new ProviderError(redact(error?.message ?? error, [apiKey]), { status: error?.status, failureClass });
    }
  }

  function stop(lane, attempts, failureClass) {
    const trail = attempts.map((entry) => `${entry.provider}:${entry.failureClass}`).join(", ");
    const verb = failureClass ? "stopped fail-closed" : "exhausted every route";
    return new RouterError(`${lane}: ${verb} (${trail})`, { attempts, failureClass });
  }

  function failureAttempt(route, error) {
    return { provider: route.provider, model: route.model, failureClass: error.failureClass, status: error.status ?? null, message: error.message };
  }

  async function judge(validate, data, route, pinned, lane, attempts) {
    let verdict;
    try {
      verdict = await validate(data, { provider: route.provider, model: route.model, pinned });
    } catch (error) {
      const attempt = { provider: route.provider, model: route.model, failureClass: "validator_error", status: null, message: redact(error?.message ?? error) };
      throw stop(lane, [...attempts, attempt], "validator_error");
    }
    if (verdict === false) return { ok: false, reason: "validator_rejected", correction: null };
    if (verdict && typeof verdict === "object" && verdict.ok === false) {
      return { ok: false, reason: String(verdict.reason || "validator_rejected").slice(0, 300), correction: verdict.correction ? String(verdict.correction) : null };
    }
    return { ok: true };
  }

  function served(result, route, index, pinned, attempts) {
    return { data: result.data, provider: route.provider, model: route.model, routeIndex: index, pinned, usage: result.usage, attempts: [...attempts], accepted: true, rejection: null, correctedRetry: null };
  }

  async function runRoutes(lane, routes, ctx) {
    const attempts = [];
    for (const [index, route] of routes.entries()) {
      let result;
      try {
        result = await callRoute(route, ctx);
      } catch (error) {
        attempts.push(failureAttempt(route, error));
        if (error.failureClass === "aborted") throw new RouterError(`${lane}: aborted by caller`, { attempts, failureClass: "aborted" });
        if (!isFallbackEligible(error.failureClass)) throw stop(lane, attempts, error.failureClass);
        continue;
      }
      const transport = allTransports[route.provider];
      const pinned = isPinnedRoute(route, ctx.schema, { transport, strict: ctx.strict });
      const answer = served(result, route, index, pinned, attempts);
      if (typeof ctx.validate !== "function") return answer;
      const verdict = await judge(ctx.validate, result.data, route, pinned, lane, attempts);
      if (verdict.ok) return answer;
      const rejected = { ...answer, accepted: false, rejection: { reason: verdict.reason } };
      // A pinned leg's answer is final. Re-rolling it would let variance launder a bad answer.
      if (pinned) return rejected;
      return correctOnPinnedLeg({ lane, routes, index, route, verdict, rejected, attempts, ctx });
    }
    throw stop(lane, attempts, null);
  }

  // A rejection from an unpinned leg is treated as decoding variance: the lane
  // makes exactly one corrected attempt on the first pinned leg after it.
  async function correctOnPinnedLeg({ lane, routes, index, route, verdict, rejected, attempts, ctx }) {
    const origin = { reason: verdict.reason, fromProvider: route.provider, fromModel: route.model };
    const pinnedIndex = routes.findIndex((candidate, position) => position > index
      && isPinnedRoute(candidate, ctx.schema, { transport: allTransports[candidate.provider], strict: ctx.strict }));
    if (pinnedIndex < 0) return { ...rejected, correctedRetry: { attempted: false, outcome: "no_pinned_leg", ...origin } };
    const pinnedRoute = routes[pinnedIndex];
    const correction = verdict.correction || `Your previous answer was rejected: ${verdict.reason}. Return a corrected JSON object.`;
    const trail = [...attempts, { provider: route.provider, model: route.model, failureClass: "validator_rejected", status: null, message: verdict.reason }];
    let result;
    try {
      result = await callRoute(pinnedRoute, { ...ctx, prompt: `${ctx.prompt}\n\n${correction}` });
    } catch (error) {
      const failed = failureAttempt(pinnedRoute, error);
      if (error.failureClass === "aborted") throw new RouterError(`${lane}: aborted by caller`, { attempts: [...trail, failed], failureClass: "aborted" });
      if (!isFallbackEligible(error.failureClass)) throw stop(lane, [...trail, failed], error.failureClass);
      // Pinned leg unreachable: hand back the original rejected answer, clearly marked.
      return { ...rejected, correctedRetry: { attempted: true, outcome: "unavailable", failureClass: error.failureClass, provider: pinnedRoute.provider, model: pinnedRoute.model, ...origin } };
    }
    const answer = served(result, pinnedRoute, pinnedIndex, true, trail);
    const second = await judge(ctx.validate, result.data, pinnedRoute, true, lane, trail);
    return {
      ...answer,
      accepted: second.ok,
      rejection: second.ok ? null : { reason: second.reason },
      correctedRetry: { attempted: true, outcome: "served", correction, ...origin }
    };
  }

  return {
    lanes: frozenLanes,

    /**
     * Run one structured-output call on a lane.
     * @param {object} input
     * @param {string} input.lane
     * @param {string} input.prompt
     * @param {string} [input.system]
     * @param {object} [input.schema]  JSON Schema for the reply
     * @param {string} [input.schemaName]
     * @param {boolean} [input.strict]  default true
     * @param {(data:any, meta:object) => any} [input.validate]
     * @param {AbortSignal} [input.signal]
     * @param {number} [input.timeoutMs]
     */
    async runJson({ lane, prompt, system = null, schema = null, schemaName = "response", strict = true, validate = null, signal, timeoutMs: callTimeoutMs } = {}) {
      const routes = frozenLanes[lane];
      if (!routes) throw new ConfigError(`unknown lane: ${lane}`);
      if (typeof prompt !== "string") throw new TypeError("prompt must be a string");
      if (signal?.aborted) throw new RouterError(`${lane}: aborted by caller`, { failureClass: "aborted" });
      const ctx = { prompt, system, schema, schemaName, strict, validate, signal, timeoutMs: callTimeoutMs ?? timeoutMs };
      const key = cache ? await answerKey({ lane, routes, system, prompt, schema, schemaName, strict }) : null;
      if (key) {
        const stored = await cache.get(key);
        if (stored) return { ...stored, cache: { hit: true, key } };
      }
      const answer = await runRoutes(lane, routes, ctx);
      if (!key) return { ...answer, cache: null };
      try {
        await cache.set(key, answer);
      } catch {
        // A failed cache write never fails a served call.
      }
      return { ...answer, cache: { hit: false, key } };
    }
  };
}
