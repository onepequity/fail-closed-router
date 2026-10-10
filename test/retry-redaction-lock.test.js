import assert from "node:assert/strict";
import test from "node:test";
import { createRouter, redact, validateLock, ConfigError } from "../src/index.js";
import { KEYS, chatReply, errorResponse, mockFetch } from "./helpers.js";

const lanes = {
  classify: [
    { provider: "openai", model: "gpt-4.1-mini", ...KEYS },
    { provider: "xai", model: "grok-3-mini", ...KEYS }
  ]
};

// ---- 429 retry -------------------------------------------------------------

test("a 429 is retried on the same route after Retry-After", async () => {
  const sleeps = [];
  const { fetch, calls } = mockFetch({ "api.openai.com": [errorResponse(429, "slow down", { "retry-after": "2" }), chatReply({ label: "ok" })] });
  const router = createRouter({ lanes, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await router.runJson({ lane: "classify", prompt: "p" });
  assert.equal(result.provider, "openai");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls.length, 2);
});

test("without Retry-After the delay backs off exponentially, capped at maxDelayMs", async () => {
  const sleeps = [];
  const { fetch } = mockFetch({ "api.openai.com": [errorResponse(429), errorResponse(429), errorResponse(429), errorResponse(429), chatReply({ label: "ok" })] });
  const router = createRouter({ lanes, fetch, retry: { maxRetries: 4, baseDelayMs: 100, maxDelayMs: 500 }, sleep: async (ms) => { sleeps.push(ms); } });
  await router.runJson({ lane: "classify", prompt: "p" });
  assert.deepEqual(sleeps, [100, 200, 400, 500]);
});

test("after retries are spent a 429 is a rate_limit failure and falls through", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": errorResponse(429), "api.x.ai": chatReply({ label: "ok" }) });
  const router = createRouter({ lanes, fetch, sleep: async () => {} });
  const result = await router.runJson({ lane: "classify", prompt: "p" });
  assert.equal(result.provider, "xai");
  assert.equal(result.attempts[0].failureClass, "rate_limit");
  assert.equal(result.attempts[0].status, 429);
  assert.equal(calls.length, 3, "one original call, one retry, then the next provider");
});

test("a Retry-After longer than maxDelayMs is not waited on", async () => {
  const sleeps = [];
  const { fetch, calls } = mockFetch({ "api.openai.com": errorResponse(429, "busy", { "retry-after": "120" }), "api.x.ai": chatReply({ label: "ok" }) });
  const router = createRouter({ lanes, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await router.runJson({ lane: "classify", prompt: "p" });
  assert.deepEqual(sleeps, []);
  assert.equal(result.provider, "xai");
  assert.equal(calls.length, 2);
});

test("a quota 429 is not retried: waiting will not refill a quota", async () => {
  const sleeps = [];
  const { fetch, calls } = mockFetch({ "api.openai.com": errorResponse(429, '{"error":{"code":"insufficient_quota"}}'), "api.x.ai": chatReply({ label: "ok" }) });
  const router = createRouter({ lanes, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await router.runJson({ lane: "classify", prompt: "p" });
  assert.deepEqual(sleeps, []);
  assert.equal(result.attempts[0].failureClass, "quota");
  assert.equal(calls.length, 2);
});

// ---- redaction -------------------------------------------------------------

test("redact removes Bearer tokens, x-api-key values and known secrets", () => {
  assert.equal(redact("header Bearer sk-live-abc123 rejected"), "header Bearer [REDACTED] rejected");
  assert.equal(redact('{"x-api-key": "secret-value-1"}'), '{"x-api-key": "[REDACTED]"}');
  assert.equal(redact("echoed my-secret-key-9999 back", ["my-secret-key-9999"]), "echoed [REDACTED] back");
});

test("tokens echoed by a provider never reach attempts or the thrown error", async () => {
  const leak = `invalid token: Bearer ${KEYS.apiKey}; raw ${KEYS.apiKey}`;
  const { fetch } = mockFetch({ "api.openai.com": errorResponse(401, leak), "api.x.ai": errorResponse(500, leak) });
  const router = createRouter({ lanes, fetch });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "p" }), (error) => {
    const serialized = JSON.stringify({ message: error.message, attempts: error.attempts });
    assert.equal(serialized.includes(KEYS.apiKey), false);
    assert.match(error.attempts[0].message, /Bearer \[REDACTED\]/);
    return true;
  });
});

// ---- lock ------------------------------------------------------------------

test("a matching lock is accepted in every entry format", () => {
  const lock = { classify: ["openai:gpt-4.1-mini", ["xai", "grok-3-mini"]] };
  assert.doesNotThrow(() => createRouter({ lanes, lock, fetch: async () => chatReply({}) }));
  assert.equal(validateLock(lanes, { classify: [{ provider: "openai", model: "gpt-4.1-mini" }, "xai:grok-3-mini"] }), true);
});

test("the lock rejects reordering, substitution, and uncovered or missing lanes at startup", () => {
  const fetch = async () => chatReply({});
  assert.throws(() => createRouter({ lanes, fetch, lock: { classify: ["xai:grok-3-mini", "openai:gpt-4.1-mini"] } }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /classify: fallback order drift/);
    return true;
  });
  assert.throws(() => createRouter({ lanes, fetch, lock: { classify: ["openai:gpt-4.1", "xai:grok-3-mini"] } }), /fallback order drift/);
  assert.throws(() => createRouter({ lanes, fetch, lock: { classify: ["openai:gpt-4.1-mini"] } }), /fallback order drift/);
  assert.throws(() => createRouter({ lanes: { ...lanes, judge: lanes.classify }, fetch, lock: { classify: ["openai:gpt-4.1-mini", "xai:grok-3-mini"] } }), /judge: lane is not covered by the lock/);
  assert.throws(() => createRouter({ lanes, fetch, lock: { classify: ["openai:gpt-4.1-mini", "xai:grok-3-mini"], extract: ["openai:m"] } }), /extract: locked lane is missing/);
});

test("routes are frozen at startup, so later mutation cannot drift past the lock", async () => {
  const mutable = { classify: [{ provider: "openai", model: "gpt-4.1-mini", ...KEYS }] };
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply({ label: "ok" }) });
  const router = createRouter({ lanes: mutable, fetch, lock: { classify: ["openai:gpt-4.1-mini"] } });
  mutable.classify[0].model = "something-else";
  mutable.classify.push({ provider: "xai", model: "x", ...KEYS });
  await router.runJson({ lane: "classify", prompt: "p" });
  assert.equal(calls[0].body.model, "gpt-4.1-mini");
  assert.equal(router.lanes.classify.length, 1);
});
