import assert from "node:assert/strict";
import test from "node:test";
import { createRouter, ConfigError, RouterError } from "../src/index.js";
import { KEYS, SCHEMA, anthropicReply, chatReply, errorResponse, mockFetch, noSleep } from "./helpers.js";

const OPENAI = "api.openai.com";
const XAI = "api.x.ai";
const ANTHROPIC = "api.anthropic.com";

const lanes = {
  classify: [
    { provider: "openai", model: "gpt-5.4-nano", ...KEYS },
    { provider: "xai", model: "grok-4.7", ...KEYS },
    { provider: "anthropic", model: "claude-sonnet-5", ...KEYS }
  ]
};

for (const [label, failure] of [
  ["503 outage", errorResponse(503, "service unavailable")],
  ["401 auth", errorResponse(401, "bad key")],
  ["quota", errorResponse(429, '{"error":{"code":"insufficient_quota"}}')],
  ["network error", new TypeError("fetch failed")],
  ["404 retired model", errorResponse(404, "model_not_found")]
]) {
  test(`an infrastructure failure (${label}) falls through to the next route`, async () => {
    const { fetch, calls } = mockFetch({ [OPENAI]: failure, [XAI]: chatReply({ label: "spam" }) });
    const router = createRouter({ lanes, fetch, sleep: noSleep, retry: { maxRetries: 0 } });
    const result = await router.runJson({ lane: "classify", prompt: "hi", schema: SCHEMA });
    assert.deepEqual(result.data, { label: "spam" });
    assert.equal(result.provider, "xai");
    assert.equal(result.routeIndex, 1);
    assert.equal(result.accepted, true);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].provider, "openai");
    assert.equal(calls.length, 2);
  });
}

test("a missing credential is an authentication failure and falls through", async () => {
  const { fetch, calls } = mockFetch({ [XAI]: chatReply({ label: "ok" }) });
  const router = createRouter({
    lanes: { classify: [{ provider: "openai", model: "m", credentialEnv: ["PRIMARY_KEY", "SECONDARY_KEY"] }, { provider: "xai", model: "m", credentialEnv: "XAI_KEY" }] },
    env: { XAI_KEY: "xai-test-key-123456" }, // gitleaks:allow (fake test fixture)
    fetch
  });
  const result = await router.runJson({ lane: "classify", prompt: "hi" });
  assert.equal(result.provider, "xai");
  assert.equal(result.attempts[0].failureClass, "authentication");
  assert.match(result.attempts[0].message, /PRIMARY_KEY or SECONDARY_KEY/);
  assert.equal(calls[0].headers.authorization, "Bearer xai-test-key-123456");
});

test("apiKey may be an async resolver", async () => {
  const { fetch, calls } = mockFetch({ [OPENAI]: chatReply({ label: "ok" }) });
  const router = createRouter({ lanes: { classify: [{ provider: "openai", model: "m", apiKey: async () => "resolved-key-0001" }] }, fetch });
  await router.runJson({ lane: "classify", prompt: "hi" });
  assert.equal(calls[0].headers.authorization, "Bearer resolved-key-0001");
});

for (const [label, reply, failureClass] of [
  ["malformed JSON", chatReply("not json {"), "malformed_output"],
  ["empty content", chatReply(""), "malformed_output"],
  ["a refusal", chatReply("", { content: null, refusal: "I can't help with that." }), "model_refusal"],
  ["a 400 bad request", errorResponse(400, "invalid_request_error"), "bad_request"]
]) {
  test(`${label} stops the chain fail-closed`, async () => {
    const { fetch, calls } = mockFetch({ [OPENAI]: reply, [XAI]: chatReply({ label: "laundered" }) });
    const router = createRouter({ lanes, fetch });
    await assert.rejects(router.runJson({ lane: "classify", prompt: "hi", schema: SCHEMA }), (error) => {
      assert.ok(error instanceof RouterError);
      assert.equal(error.failureClass, failureClass);
      assert.match(error.message, new RegExp(`classify: stopped fail-closed \\(openai:${failureClass}\\)`));
      return true;
    });
    assert.equal(calls.length, 1, "no other provider is asked once the output is bad");
  });
}

test("schema-validation failure raised by a custom transport stops the chain", async () => {
  const strictLocal = {
    capabilities: { jsonSchema: true, temperature: true },
    async call() {
      throw new Error("reply failed schema validation: label must be a string");
    }
  };
  const { fetch, calls } = mockFetch({ [OPENAI]: chatReply({ label: "laundered" }) });
  const router = createRouter({ lanes: { classify: [{ provider: "local", model: "m", apiKey: "local-key-0001" }, lanes.classify[0]] }, transports: { local: strictLocal }, fetch });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "hi", schema: SCHEMA }), /stopped fail-closed \(local:malformed_output\)/);
  assert.equal(calls.length, 0);
});

test("an unknown failure stops the chain", async () => {
  const { fetch, calls } = mockFetch({ [OPENAI]: new Error("something inexplicable"), [XAI]: chatReply({ label: "x" }) });
  const router = createRouter({ lanes, fetch });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "hi" }), /openai:unknown/);
  assert.equal(calls.length, 1);
});

test("a validator that throws stops the chain", async () => {
  const { fetch } = mockFetch({ [OPENAI]: chatReply({ label: "x" }) });
  const router = createRouter({ lanes, fetch });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "hi", validate: () => { throw new Error("boom"); } }), (error) => {
    assert.equal(error.failureClass, "validator_error");
    return true;
  });
});

test("exhausting every route fails closed with the full trail", async () => {
  const { fetch, calls } = mockFetch({ [OPENAI]: errorResponse(503), [XAI]: errorResponse(500), [ANTHROPIC]: errorResponse(529) });
  const router = createRouter({ lanes, fetch });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "hi" }), (error) => {
    assert.match(error.message, /classify: exhausted every route \(openai:provider_unavailable, xai:provider_unavailable, anthropic:provider_unavailable\)/);
    assert.equal(error.attempts.length, 3);
    assert.equal(error.failureClass, null);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("a caller abort does not fall through", async () => {
  const controller = new AbortController();
  const { fetch, calls } = mockFetch({
    [OPENAI]: () => {
      controller.abort();
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    },
    [XAI]: chatReply({ label: "x" })
  });
  const router = createRouter({ lanes, fetch });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "hi", signal: controller.signal }), (error) => error.failureClass === "aborted");
  assert.equal(calls.length, 1);
});

test("a request that exceeds timeoutMs is a timeout and falls through", async () => {
  // The first provider never answers; it only rejects when the router's signal fires.
  const fetch = (url, init) => url.includes(OPENAI)
    ? new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
    : Promise.resolve(chatReply({ label: "ok" }));
  const router = createRouter({ lanes, fetch, timeoutMs: 20 });
  const result = await router.runJson({ lane: "classify", prompt: "hi" });
  assert.equal(result.provider, "xai");
  assert.equal(result.attempts[0].failureClass, "timeout");
});

test("unknown lanes are rejected; there is no cross-lane substitution", async () => {
  const router = createRouter({ lanes, fetch: async () => chatReply({}) });
  await assert.rejects(router.runJson({ lane: "extract", prompt: "hi" }), ConfigError);
});

test("startup validation rejects bad configuration", () => {
  assert.throws(() => createRouter({ lanes: {} }), ConfigError);
  assert.throws(() => createRouter({ lanes: { a: [] } }), /at least one route/);
  assert.throws(() => createRouter({ lanes: { a: [{ provider: "nope", model: "m" }] } }), /no transport registered/);
  assert.throws(() => createRouter({ lanes: { a: [{ provider: "openai" }] } }), /provider and model are required/);
  assert.throws(() => createRouter({ lanes: { a: [{ provider: "anthropic", model: "m", temperature: 0, pinned: true }] } }), /pinned requires/);
  assert.throws(() => createRouter({ lanes: { a: [{ provider: "openai", model: "m", temperature: 0.7, pinned: true }] } }), /pinned requires/);
});

test("OpenAI-style request: strict json_schema when a schema is given, json_object otherwise", async () => {
  const { fetch, calls } = mockFetch({ [OPENAI]: chatReply({ label: "ok" }) });
  const router = createRouter({ lanes: { classify: [{ provider: "openai", model: "m", temperature: 0, ...KEYS }] }, fetch });
  await router.runJson({ lane: "classify", prompt: "hi", system: "be terse", schema: SCHEMA, schemaName: "label" });
  await router.runJson({ lane: "classify", prompt: "hi" });
  await router.runJson({ lane: "classify", prompt: "hi", schema: SCHEMA, strict: false });
  assert.deepEqual(calls[0].body.response_format, { type: "json_schema", json_schema: { name: "label", strict: true, schema: SCHEMA } });
  assert.deepEqual(calls[0].body.messages[0], { role: "system", content: "be terse" });
  assert.equal(calls[0].body.temperature, 0);
  assert.deepEqual(calls[1].body.response_format, { type: "json_object" });
  assert.equal(calls[2].body.response_format.json_schema.strict, false);
});

test("a route that disables the temperature capability never sends temperature", async () => {
  const { fetch, calls } = mockFetch({ [OPENAI]: chatReply({ label: "ok" }) });
  const router = createRouter({ lanes: { classify: [{ provider: "openai", model: "m", temperature: 0, capabilities: { temperature: false }, ...KEYS }] }, fetch });
  const result = await router.runJson({ lane: "classify", prompt: "hi", schema: SCHEMA });
  assert.equal("temperature" in calls[0].body, false);
  assert.equal(result.pinned, false, "without temperature control the leg cannot be pinned");
});

test("baseUrl points a built-in transport at any compatible endpoint", async () => {
  const { fetch, calls } = mockFetch({ "localhost:8080": chatReply({ label: "ok" }) });
  const router = createRouter({ lanes: { classify: [{ provider: "openai", model: "local", baseUrl: "http://localhost:8080/v1/", ...KEYS }] }, fetch });
  await router.runJson({ lane: "classify", prompt: "hi" });
  assert.equal(calls[0].url, "http://localhost:8080/v1/chat/completions");
});

test("Anthropic request carries the schema as an instruction and parses text blocks", async () => {
  const { fetch, calls } = mockFetch({ [ANTHROPIC]: anthropicReply({ label: "ok" }) });
  const router = createRouter({ lanes: { judge: [{ provider: "anthropic", model: "claude-sonnet-5", ...KEYS }] }, fetch });
  const result = await router.runJson({ lane: "judge", prompt: "hi", system: "sys", schema: SCHEMA });
  assert.deepEqual(result.data, { label: "ok" });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["x-api-key"], KEYS.apiKey);
  assert.match(calls[0].body.system, /^sys\n\nRespond with exactly one JSON object/);
  assert.equal(result.pinned, false);
});
