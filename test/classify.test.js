import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderFailure, classifyStatus, isFallbackEligible, INFRA_FAILURES, ProviderError } from "../src/index.js";

const messageTable = [
  ["provider returned 401", "authentication"],
  ["403 Forbidden", "authentication"],
  ["invalid api key supplied", "authentication"],
  ["openai credential is unavailable (MY_KEY)", "authentication"],
  ["usage quota exhausted", "quota"],
  ["You exceeded your current quota: insufficient_quota", "quota"],
  ["provider returned 429", "rate_limit"],
  ["Rate limit reached for requests", "rate_limit"],
  ["provider returned 503", "provider_unavailable"],
  ["502 Bad Gateway", "provider_unavailable"],
  ["fetch failed", "provider_unavailable"],
  ["connect ECONNREFUSED 127.0.0.1:443", "provider_unavailable"],
  ["socket hang up", "provider_unavailable"],
  ["model_not_found", "provider_unavailable"],
  ["request timed out", "timeout"],
  ["This operation was aborted", "timeout"],
  ["provider returned 400: bad request", "bad_request"],
  ["provider returned malformed JSON", "malformed_output"],
  ["provider returned no content", "malformed_output"],
  ["output failed schema validation", "malformed_output"],
  ["something inexplicable", "unknown"]
];

test("classifyProviderFailure maps messages to failure classes", () => {
  for (const [message, expected] of messageTable) {
    assert.equal(classifyProviderFailure(new Error(message)), expected, message);
  }
  assert.equal(classifyProviderFailure("plain string timeout"), "timeout");
});

test("explicit failureClass, then status, then error name take precedence over the message", () => {
  assert.equal(classifyProviderFailure(new ProviderError("returned 503", { failureClass: "malformed_output" })), "malformed_output");
  assert.equal(classifyProviderFailure(Object.assign(new Error("anything"), { status: 401 })), "authentication");
  assert.equal(classifyProviderFailure(Object.assign(new Error("anything"), { name: "AbortError" })), "timeout");
  assert.equal(classifyProviderFailure(Object.assign(new Error("anything"), { name: "TimeoutError" })), "timeout");
});

test("classifyStatus covers the HTTP table", () => {
  const table = [
    [401, "authentication"], [403, "authentication"], [402, "quota"], [429, "rate_limit"],
    [408, "timeout"], [504, "timeout"], [404, "provider_unavailable"], [500, "provider_unavailable"],
    [503, "provider_unavailable"], [529, "provider_unavailable"], [400, "bad_request"], [422, "bad_request"], [418, "unknown"]
  ];
  for (const [status, expected] of table) assert.equal(classifyStatus(status), expected, String(status));
  assert.equal(classifyStatus(429, '{"error":{"code":"insufficient_quota"}}'), "quota");
});

test("only infrastructure classes are fallback eligible", () => {
  assert.deepEqual([...INFRA_FAILURES].sort(), ["authentication", "provider_unavailable", "quota", "rate_limit", "timeout"]);
  for (const cls of INFRA_FAILURES) assert.equal(isFallbackEligible(cls), true, cls);
  for (const cls of ["malformed_output", "model_refusal", "bad_request", "validator_rejected", "validator_error", "aborted", "unknown"]) {
    assert.equal(isFallbackEligible(cls), false, cls);
  }
});
