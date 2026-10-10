import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerKey, canonicalJson, createRouter, memoryCache } from "../src/index.js";
import { fileCache } from "../src/file-cache.js";
import { KEYS, SCHEMA, chatReply, errorResponse, mockFetch } from "./helpers.js";

const lanes = { classify: [{ provider: "openai", model: "m", temperature: 0, ...KEYS }] };

test("identical inputs replay the stored answer without a provider call", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": [chatReply({ label: "a" }), chatReply({ label: "b" })] });
  const router = createRouter({ lanes, fetch, cache: memoryCache() });
  const first = await router.runJson({ lane: "classify", prompt: "same", schema: SCHEMA });
  const second = await router.runJson({ lane: "classify", prompt: "same", schema: SCHEMA });
  assert.equal(calls.length, 1);
  assert.deepEqual(second.data, first.data);
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(second.cache.key, first.cache.key);
  assert.match(first.cache.key, /^[a-f0-9]{64}$/);
});

test("refusals replay too: a rejected answer is stored and served again", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": [chatReply({ label: "" }), chatReply({ label: "fresh" })] });
  const router = createRouter({ lanes, fetch, cache: memoryCache() });
  const validate = (data) => ({ ok: Boolean(data.label), reason: "empty_label" });
  const first = await router.runJson({ lane: "classify", prompt: "p", schema: SCHEMA, validate });
  const second = await router.runJson({ lane: "classify", prompt: "p", schema: SCHEMA, validate });
  assert.equal(calls.length, 1);
  assert.equal(first.accepted, false);
  assert.equal(second.accepted, false);
  assert.deepEqual(second.rejection, { reason: "empty_label" });
  assert.equal(second.cache.hit, true);
});

test("failed calls are never stored", async () => {
  const { fetch, calls } = mockFetch({ "api.openai.com": [errorResponse(503), chatReply({ label: "ok" })] });
  const router = createRouter({ lanes, fetch, cache: memoryCache() });
  await assert.rejects(router.runJson({ lane: "classify", prompt: "p" }));
  const result = await router.runJson({ lane: "classify", prompt: "p" });
  assert.equal(calls.length, 2);
  assert.equal(result.cache.hit, false);
});

test("the key changes with every input that shapes the answer, and never with credentials", async () => {
  const base = { lane: "classify", routes: lanes.classify, system: "s", prompt: "p", schema: SCHEMA, schemaName: "x" };
  const key = await answerKey(base);
  assert.equal(await answerKey({ ...base }), key);
  assert.equal(await answerKey({ ...base, schema: { properties: SCHEMA.properties, required: SCHEMA.required, additionalProperties: false, type: "object" } }), key, "key order in the schema does not matter");
  assert.equal(await answerKey({ ...base, routes: [{ ...lanes.classify[0], apiKey: "other-key-000000" }] }), key);
  for (const change of [{ lane: "judge" }, { system: "t" }, { prompt: "q" }, { schema: { type: "object" } }, { schemaName: "y" }, { strict: false }, { routes: [{ ...lanes.classify[0], temperature: 0.5 }] }, { routes: [{ ...lanes.classify[0], model: "n" }] }]) {
    assert.notEqual(await answerKey({ ...base, ...change }), key, JSON.stringify(change));
  }
});

test("canonicalJson sorts keys and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
});

test("memoryCache returns copies and honours maxEntries", () => {
  const cache = memoryCache({ maxEntries: 2 });
  const value = { data: { n: 1 } };
  cache.set("a", value);
  value.data.n = 99;
  assert.equal(cache.get("a").data.n, 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
});

test("fileCache persists answers across router instances and expires by ttl", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fcr-cache-"));
  try {
    let clock = 1_000;
    const now = () => clock;
    const { fetch, calls } = mockFetch({ "api.openai.com": [chatReply({ label: "one" }), chatReply({ label: "two" })] });
    const first = await createRouter({ lanes, fetch, cache: fileCache(dir, { ttlMs: 500, now }) }).runJson({ lane: "classify", prompt: "p" });
    const replay = await createRouter({ lanes, fetch, cache: fileCache(dir, { ttlMs: 500, now }) }).runJson({ lane: "classify", prompt: "p" });
    assert.equal(calls.length, 1);
    assert.deepEqual(replay.data, { label: "one" });
    assert.equal(replay.cache.hit, true);
    const shard = await readdir(dir);
    assert.deepEqual(shard, [first.cache.key.slice(0, 2)]);
    clock += 1_000;
    const expired = await createRouter({ lanes, fetch, cache: fileCache(dir, { ttlMs: 500, now }) }).runJson({ lane: "classify", prompt: "p" });
    assert.equal(expired.cache.hit, false);
    assert.deepEqual(expired.data, { label: "two" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cache write failure never fails a served call", async () => {
  const { fetch } = mockFetch({ "api.openai.com": chatReply({ label: "ok" }) });
  const broken = { get: () => undefined, set: () => { throw new Error("disk full"); } };
  const result = await createRouter({ lanes, fetch, cache: broken }).runJson({ lane: "classify", prompt: "p" });
  assert.deepEqual(result.data, { label: "ok" });
});
