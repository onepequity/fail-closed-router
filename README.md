# fail-closed-router

**Fail-closed structured-output routing across LLM providers.**

`fail-closed-router` sends a JSON-schema request down an ordered list of providers (a "lane") and has one firm rule about when it may move to the next one: only when the previous provider could not answer at all. Authentication errors, exhausted quotas, rate limits, outages and timeouts fall through. A malformed reply, a refusal, or an answer your validator rejects stops the chain, so a bad answer is never quietly replaced by a second opinion from another vendor. On top of that rule it adds one controlled correction step, a deterministic answer cache for reproducible runs, 429 backoff and credential redaction. It is small, has zero dependencies, and runs on Node 20+ and fetch-based edge runtimes.

## Why fail-closed matters

Most fallback logic treats every error the same: something went wrong, try the next model. For structured output that is dangerous. If provider A returns an answer that fails your checks and the router silently asks provider B, you end up shipping whichever answer happened to pass, and you lose the signal that something about the input or the prompt is wrong. That is answer laundering.

```
              infra failure (auth, quota, 429, 5xx, timeout)
  [route 1] ------------------------------------------------> [route 2] --> ...
      |
      | bad output (malformed JSON, refusal, schema failure, unknown error)
      v
    STOP  (RouterError with the full attempt trail)
```

| What happened on a route | Failure class | Next route tried? |
| --- | --- | --- |
| 401 / 403 / missing key | `authentication` | yes |
| quota exhausted (402, `insufficient_quota`) | `quota` | yes |
| 429 after retries | `rate_limit` | yes |
| 5xx, network error, 404 model not found | `provider_unavailable` | yes |
| request timeout, 408, 504 | `timeout` | yes |
| 400 / 422 request rejected | `bad_request` | **no** |
| unparseable JSON or empty reply | `malformed_output` | **no** |
| explicit model refusal | `model_refusal` | **no** |
| validator threw | `validator_error` | **no** |
| anything unrecognised | `unknown` | **no** |
| caller aborted via `signal` | `aborted` | **no** |

### The one controlled exception: a single pinned retry

A reply that parses but that your `validate` function rejects is handled differently depending on where it came from:

- **Unpinned leg** (default temperature, or no enforced schema): the rejection is treated as decoding variance. The router makes **exactly one** corrected attempt on the first *pinned* leg after it, with your correction text appended to the prompt.
- **Pinned leg** (temperature 0 and a transport that enforces a strict JSON schema): the answer is final. It is returned with `accepted: false` and is **never re-rolled**, because a second roll of the dice is exactly how bad answers get laundered.

Pinning is decided by capability flags, not by model-name patterns. See [Pinned legs](#pinned-legs).

### Deterministic answer cache

With a cache configured, every call is keyed by a SHA-256 of everything that shapes the answer: lane, the lane's routes and decoding settings, system prompt, prompt and schema. Identical inputs replay the stored result, including rejected answers, so a rerun takes the same path as the original. Failed calls are never stored. This makes CI runs and previews reproducible without mocking.

## Install

```sh
npm install github:onepequity/fail-closed-router
```

Requires Node 20 or newer, or any runtime with `fetch`, `AbortController` and Web Crypto. Zero dependencies.

## Quick start

```js
import { createRouter, memoryCache } from "fail-closed-router";

const router = createRouter({
  lanes: {
    classify: [
      { provider: "openai", model: "gpt-5.4-nano", credentialEnv: "OPENAI_API_KEY" },
      { provider: "xai", model: "grok-4.7", temperature: 0, credentialEnv: "XAI_API_KEY" },
      { provider: "anthropic", model: "claude-sonnet-5", credentialEnv: "ANTHROPIC_API_KEY" }
    ]
  },
  lock: { classify: ["openai:gpt-5.4-nano", "xai:grok-4.7", "anthropic:claude-sonnet-5"] },
  cache: memoryCache()
});

const result = await router.runJson({
  lane: "classify",
  system: "You label support tickets.",
  prompt: "Ticket: my invoice was charged twice.",
  schema: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", enum: ["billing", "bug", "other"] } } },
  validate: (data) => data.label !== "other" || { ok: false, reason: "too_vague", correction: "Pick billing or bug if either applies." }
});
console.log(result.data, result.provider, result.accepted);
```

If `gpt-5.4-nano` is down, the call moves to `grok-4.7`. If `gpt-5.4-nano` answers `"other"`, the validator rejects it and the router makes one corrected attempt on `grok-4.7`, which is pinned (temperature 0 plus strict schema). If any provider returns malformed JSON, the call throws.

## API reference

### `createRouter(options)`

| Option | Type | Description |
| --- | --- | --- |
| `lanes` | `Record<string, Route[]>` | Required. Ordered routes per lane. There is no cross-lane substitution. |
| `lock` | `Record<string, LockEntry[]>` | Optional expected fallback order, checked at startup. See [Lock](#lock). |
| `cache` | `{ get(key), set(key, value) }` | Optional answer cache (sync or async). Use `memoryCache()` or `fileCache(dir)`. |
| `fetch` | `typeof fetch` | Defaults to `globalThis.fetch`. Inject a mock in tests. |
| `transports` | `Record<string, Transport>` | Extra or replacement provider transports. |
| `env` | `Record<string, string>` | Where `credentialEnv` names are looked up. Defaults to `process.env` when it exists. |
| `timeoutMs` | `number` | Per-request timeout. Default `60000`. |
| `retry` | `{ maxRetries, baseDelayMs, maxDelayMs }` | 429 policy. Default `{ 1, 1000, 15000 }`. |
| `sleep` | `(ms, signal) => Promise` | Test hook for retry delays. |

Configuration is validated when the router is created: unknown providers, empty lanes, a `pinned: true` route that cannot actually be pinned, and lock drift all throw `ConfigError`. Routes are copied and frozen, so mutating your config object later changes nothing.

### `Route`

| Field | Description |
| --- | --- |
| `provider` | `"openai"`, `"anthropic"`, `"xai"`, or the name of a custom transport. |
| `model` | Model id sent to the provider. Never aliased or rewritten. |
| `apiKey` | A string, or a (possibly async) function returning one. |
| `credentialEnv` | Env var name, or list of names tried in order. The only place the library reads the environment. |
| `baseUrl` | Override the endpoint, for example any OpenAI-compatible server. |
| `temperature` | Sent only when the transport and route allow it. |
| `maxOutputTokens` | Default `4096`. |
| `pinned` | `true` asserts the leg is pinned (checked at startup), `false` opts out, omitted means derived. |
| `capabilities` | `{ temperature?: false, jsonSchema?: false }` switches a capability off for one route, for models that reject a parameter. Routes can switch capabilities off, never on. |

A missing credential is classified as `authentication`, so the lane moves on to a provider you do have a key for.

### `router.runJson(input)`

| Input | Description |
| --- | --- |
| `lane` | Lane name. Unknown lanes throw. |
| `prompt` | User prompt (string). |
| `system` | Optional system prompt. |
| `schema` | Optional JSON Schema. Without one, no leg is pinned and replies are requested as a JSON object. |
| `schemaName`, `strict` | Defaults `"response"` and `true`. `strict: false` is forwarded and disables pinning. |
| `validate(data, meta)` | Optional. Return `true`/`undefined`/`{ ok: true }` to accept, `false` or `{ ok: false, reason, correction }` to reject. Throwing stops the chain. |
| `signal` | `AbortSignal`. An abort stops immediately and never falls through. |
| `timeoutMs` | Per-call override. |

Resolves to:

```ts
{
  data, provider, model, routeIndex, pinned, usage,
  accepted: boolean,                     // false when the served answer was rejected
  rejection: { reason } | null,
  attempts: Attempt[],                   // every failed or rejected attempt before this answer
  correctedRetry: null | { attempted, outcome: "served" | "no_pinned_leg" | "unavailable", reason, fromProvider, fromModel, ... },
  cache: { hit, key } | null
}
```

Rejects with `RouterError` (`message`, `failureClass`, `attempts`) when the chain stops or every route is exhausted. Attempt messages are redacted and truncated.

Note that a rejected answer is *returned*, not thrown, so you decide what to do with it. Check `accepted`.

### Pinned legs

A leg is pinned when all of these hold:

1. the call has a `schema` and `strict` is not `false`;
2. the route has `temperature: 0` and `pinned` is not `false`;
3. the transport's capabilities include both `temperature` and `jsonSchema`, and the route does not switch either off.

The built-in `openai` and `xai` transports declare both capabilities. The built-in `anthropic` transport sends the schema as an instruction rather than an enforced format, so its legs are never pinned. A custom transport can declare `{ jsonSchema: true, temperature: true }` if its endpoint enforces both.

If the pinned leg is unreachable during the corrected retry (an infrastructure failure), the original rejected answer is returned with `correctedRetry.outcome === "unavailable"`. If the pinned leg returns malformed output, the chain stops.

### Lock

`lock` replaces hard-coded "approved order" tables with a declaration you keep next to your config:

```js
lock: {
  extract: ["openai:gpt-5.4-nano", ["xai", "grok-4.7"]],
  judge: [{ provider: "openai", model: "gpt-4.1" }]
}
```

At startup every lane must match its lock exactly (same routes, same order), every lane must be covered, and every locked lane must exist. Anything else throws `ConfigError: <lane>: fallback order drift`. Use it to stop a config edit or an environment-specific override from silently reordering providers.

### Caches

```js
import { memoryCache } from "fail-closed-router";
import { fileCache } from "fail-closed-router/file-cache"; // Node only

memoryCache({ maxEntries: 1000 });
fileCache(".answer-cache", { ttlMs: 14 * 24 * 3600 * 1000 });
```

Any object with `get(key)` and `set(key, value)` works (Redis, KV, and so on). A cache write that fails never fails the call. `answerKey(input)` is exported if you want to compute keys yourself.

### Custom transports

```js
const transports = {
  local: {
    capabilities: { jsonSchema: true, temperature: true },
    buildRequest: ({ route, apiKey, prompt, system, schema, schemaName, strict, capabilities }) => ({ url, headers, body }),
    parseResponse: (json) => ({ content: json.text, usage: json.usage })
  }
};
```

Or provide `call(input)` returning `{ content }` or `{ data }` for non-HTTP backends. Errors you throw are classified like any other; set `error.failureClass` to be explicit.

### Other exports

- `classifyProviderFailure(error)`: the classification table above, as a function. Honours `error.failureClass`, then `error.status`, then `AbortError`/`TimeoutError`, then message patterns.
- `classifyStatus(status, text)`, `isFallbackEligible(cls)`, `INFRA_FAILURES`
- `isPinnedRoute(route, schema, { transport, strict })`
- `validateLock(lanes, lock)`
- `redact(message, secrets)`: strips `Bearer` tokens, `x-api-key` values and any listed secret.
- `RouterError`, `ConfigError`, `ProviderError`

### 429 handling

A plain 429 is retried on the same route, honouring `Retry-After` (seconds or HTTP date) and otherwise backing off exponentially from `baseDelayMs`, capped at `maxDelayMs`. If the server asks for a longer wait than `maxDelayMs`, the router does not wait and moves to the next route. A 429 whose body says the quota is exhausted is classified as `quota` and not retried.

## How this compares

Honest positioning: this is a focused policy library, not a gateway.

| | Scope | Fallback trigger |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm) | Proxy and SDK for 100+ providers, budgets, logging, load balancing | Configurable; broad by default |
| [OpenRouter](https://openrouter.ai) | Hosted API with many models behind one key | Provider availability |
| [Portkey](https://portkey.ai) | Hosted or self-hosted gateway, observability, guardrails | Configurable status codes |
| [Vercel AI SDK](https://sdk.vercel.ai) | Full TypeScript toolkit: streaming, tools, UI hooks, many providers | You build it |
| **fail-closed-router** | One function: structured JSON calls over an ordered lane | Infrastructure failures only, by design |

If you need streaming, tool calling, embeddings, spend tracking or dozens of providers, use one of the tools above. You can also use them underneath this library, by pointing a route's `baseUrl` at a LiteLLM or Portkey endpoint, or by wrapping another SDK in a custom transport. What this library adds is the policy: which failures may move on, the single pinned correction, refusing to re-roll pinned answers, and reproducible replays.

## Development

```sh
npm test
```

Tests use `node:test` with a mocked `fetch`. They make no network calls.

## License

[MIT](./LICENSE)
