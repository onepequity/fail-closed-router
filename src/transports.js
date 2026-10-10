/**
 * Built-in HTTP transports. Each transport declares its capabilities and knows
 * how to build one request and read one response. The router owns fetch,
 * timeouts, 429 retries, classification and redaction, so a transport stays
 * a pair of pure functions.
 *
 * Capabilities:
 *   jsonSchema   the endpoint enforces a strict JSON schema on the reply
 *   temperature  the endpoint accepts a temperature override
 *
 * A route may override either flag with `capabilities: { temperature: false }`
 * for models that reject a parameter. That flag, not the model name, decides
 * what is sent and whether the leg can be pinned.
 */

const SCHEMA_INSTRUCTION = "Respond with exactly one JSON object that validates against this JSON Schema and nothing else:";

function chatCompletions({ defaultBaseUrl, maxTokensParam }) {
  return {
    capabilities: { jsonSchema: true, temperature: true },
    buildRequest({ route, apiKey, prompt, system, schema, schemaName, strict, capabilities }) {
      const body = {
        model: route.model,
        [maxTokensParam]: route.maxOutputTokens ?? 4096,
        response_format: schema
          ? { type: "json_schema", json_schema: { name: schemaName, strict, schema } }
          : { type: "json_object" },
        messages: [
          ...(system ? [{ role: "system", content: String(system) }] : []),
          { role: "user", content: `${prompt}\n\nReturn only the JSON object.` }
        ]
      };
      if (capabilities.temperature && Number.isFinite(route.temperature)) body.temperature = route.temperature;
      return {
        url: `${(route.baseUrl || defaultBaseUrl).replace(/\/+$/, "")}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body)
      };
    },
    parseResponse(json) {
      const message = json?.choices?.[0]?.message;
      return { content: message?.content ?? null, refusal: message?.refusal ?? null, usage: json?.usage ?? null };
    }
  };
}

export const openai = chatCompletions({ defaultBaseUrl: "https://api.openai.com/v1", maxTokensParam: "max_completion_tokens" });
export const xai = chatCompletions({ defaultBaseUrl: "https://api.x.ai/v1", maxTokensParam: "max_tokens" });

export const anthropic = {
  // The built-in Messages transport carries the schema as an instruction, not
  // as an enforced response format, so its legs are never pinned.
  capabilities: { jsonSchema: false, temperature: true },
  buildRequest({ route, apiKey, prompt, system, schema, capabilities }) {
    const schemaLine = schema ? `${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}` : "Respond with exactly one JSON object and nothing else.";
    const body = {
      model: route.model,
      max_tokens: route.maxOutputTokens ?? 4096,
      system: [system, schemaLine].filter(Boolean).join("\n\n"),
      messages: [{ role: "user", content: `${prompt}\n\nReturn only the JSON object.` }]
    };
    if (capabilities.temperature && Number.isFinite(route.temperature)) body.temperature = route.temperature;
    return {
      url: `${(route.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "")}/messages`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body)
    };
  },
  parseResponse(json) {
    const content = (json?.content || []).filter((block) => block?.type === "text").map((block) => block.text).join("");
    return { content: content || null, refusal: json?.stop_reason === "refusal" ? "refusal" : null, usage: json?.usage ?? null };
  }
};

export const builtinTransports = Object.freeze({ openai, xai, anthropic });

/**
 * Effective capabilities for a route. A route can only switch a transport
 * capability off, never on: claiming schema enforcement the endpoint does not
 * provide would make a leg look pinned when it is not.
 */
export function routeCapabilities(route, transport) {
  const base = transport?.capabilities || {};
  const own = route?.capabilities || {};
  return {
    jsonSchema: base.jsonSchema === true && own.jsonSchema !== false,
    temperature: base.temperature !== false && own.temperature !== false
  };
}
