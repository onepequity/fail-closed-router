import assert from "node:assert/strict";
import test from "node:test";
import { createRouter, isPinnedRoute } from "../src/index.js";
import { KEYS, SCHEMA, chatReply, errorResponse, mockFetch } from "./helpers.js";

// Lane under test: leg 0 is unpinned (no temperature), leg 1 is unpinned
// (Anthropic cannot enforce a schema), leg 2 is pinned (temperature 0 on a
// transport that enforces a strict JSON schema), leg 3 is a later pinned leg.
const lanes = {
  extract: [
    { provider: "openai", model: "fast-model", ...KEYS },
    { provider: "anthropic", model: "claude-sonnet-4-5", temperature: 0, ...KEYS },
    { provider: "xai", model: "grok-3-mini", temperature: 0, ...KEYS },
    { provider: "openai", model: "careful-model", temperature: 0, baseUrl: "https://second.example/v1", ...KEYS }
  ]
};
const good = { label: "invoice" };
const bad = { label: "" };
const validate = (data) => (data.label ? { ok: true } : { ok: false, reason: "empty_label", correction: "Previous answer rejected: label was empty. Choose a label." });

test("isPinnedRoute needs temperature 0, schema enforcement and a schema on the call", () => {
  assert.deepEqual(lanes.extract.map((route) => isPinnedRoute(route, SCHEMA)), [false, false, true, true]);
  assert.equal(isPinnedRoute(lanes.extract[2], null), false, "no schema, no pin");
  assert.equal(isPinnedRoute(lanes.extract[2], SCHEMA, { strict: false }), false, "non-strict schema, no pin");
  assert.equal(isPinnedRoute({ ...lanes.extract[2], pinned: false }, SCHEMA), false, "explicit opt-out");
  assert.equal(isPinnedRoute({ ...lanes.extract[2], capabilities: { jsonSchema: false } }, SCHEMA), false);
  assert.equal(isPinnedRoute({ ...lanes.extract[1], capabilities: { jsonSchema: true } }, SCHEMA), false, "routes cannot switch a capability on");
  const custom = { capabilities: { jsonSchema: true, temperature: true }, call: async () => ({}) };
  assert.equal(isPinnedRoute({ provider: "local", model: "m", temperature: 0 }, SCHEMA, { transport: custom }), true);
});

test("a rejection on an unpinned leg gets exactly one corrected retry on the first pinned leg", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad), "api.x.ai": chatReply(good), "second.example": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "USER-INPUT", system: "SYS", schema: SCHEMA, validate });

  assert.deepEqual(calls.map((call) => new URL(call.url).host), ["api.openai.com", "api.x.ai"], "skips the unpinned Anthropic leg, stops after one retry");
  const retry = calls[1].body;
  assert.equal(retry.temperature, 0);
  assert.equal(retry.response_format.type, "json_schema");
  assert.equal(retry.response_format.json_schema.strict, true);
  assert.match(retry.messages.at(-1).content, /^USER-INPUT\n\nPrevious answer rejected: label was empty\. Choose a label\./);

  assert.deepEqual(result.data, good);
  assert.equal(result.provider, "xai");
  assert.equal(result.routeIndex, 2);
  assert.equal(result.pinned, true);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.correctedRetry, {
    attempted: true, outcome: "served", correction: "Previous answer rejected: label was empty. Choose a label.",
    reason: "empty_label", fromProvider: "openai", fromModel: "fast-model"
  });
  assert.deepEqual(result.attempts.map((row) => `${row.provider}:${row.failureClass}`), ["openai:validator_rejected"]);
});

test("a default correction is generated when the validator gives none; `false` counts as a rejection", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad), "api.x.ai": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "P", schema: SCHEMA, validate: (data) => Boolean(data.label) });
  assert.match(calls[1].body.messages.at(-1).content, /^P\n\nYour previous answer was rejected: validator_rejected\./);
  assert.equal(result.accepted, true);
});

test("a pinned leg's answer is never re-rolled, even when the validator rejects it", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": errorResponse(503), "api.anthropic.com": errorResponse(503), "api.x.ai": chatReply(bad), "second.example": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "P", schema: SCHEMA, validate });
  assert.equal(calls.filter((call) => call.url.includes("api.x.ai")).length, 1);
  assert.equal(calls.some((call) => call.url.includes("second.example")), false, "no later pinned leg gets a second roll");
  assert.deepEqual(result.data, bad);
  assert.equal(result.pinned, true);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejection, { reason: "empty_label" });
  assert.equal(result.correctedRetry, null);
});

test("the corrected retry is judged once and not retried again if it is also rejected", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad), "api.x.ai": chatReply(bad), "second.example": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "P", schema: SCHEMA, validate });
  assert.equal(calls.length, 2);
  assert.equal(result.accepted, false);
  assert.equal(result.pinned, true);
  assert.equal(result.correctedRetry.outcome, "served");
});

test("malformed output from the pinned retry still stops the chain", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad), "api.x.ai": chatReply("not json {"), "second.example": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  await assert.rejects(router.runJson({ lane: "extract", prompt: "P", schema: SCHEMA, validate }), /extract: stopped fail-closed \(openai:validator_rejected, xai:malformed_output\)/);
  assert.equal(calls.length, 2);
});

test("an unreachable pinned leg returns the original rejected answer, clearly marked", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad), "api.x.ai": new TypeError("fetch failed"), "second.example": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "P", schema: SCHEMA, validate });
  assert.equal(calls.length, 2, "exactly one corrected retry, even when it is unavailable");
  assert.deepEqual(result.data, bad);
  assert.equal(result.provider, "openai");
  assert.equal(result.pinned, false);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.correctedRetry, {
    attempted: true, outcome: "unavailable", failureClass: "provider_unavailable", provider: "xai", model: "grok-3-mini",
    reason: "empty_label", fromProvider: "openai", fromModel: "fast-model"
  });
});

test("without a schema no leg is pinned, so a rejection is reported and nothing is retried", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad), "api.x.ai": chatReply(good) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "P", validate });
  assert.equal(calls.length, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.correctedRetry.outcome, "no_pinned_leg");
});

test("without a validator the first successful leg is served as-is", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": chatReply(bad) });
  const router = createRouter({ lanes, fetch });
  const result = await router.runJson({ lane: "extract", prompt: "P", schema: SCHEMA });
  assert.equal(calls.length, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.correctedRetry, null);
});
