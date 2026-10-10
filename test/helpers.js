// Test helpers: a scripted fetch that never touches the network.

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

export function chatReply(data, extra = {}) {
  const content = typeof data === "string" ? data : JSON.stringify(data);
  return jsonResponse({ choices: [{ message: { content, ...extra } }], usage: { total_tokens: 3 } });
}

export function anthropicReply(data) {
  return jsonResponse({ content: [{ type: "text", text: JSON.stringify(data) }], usage: { input_tokens: 1, output_tokens: 1 } });
}

export function errorResponse(status, text = "error", headers = {}) {
  return jsonResponse(text, { status, headers });
}

/**
 * Build a fetch mock. `script` maps a URL substring (or a function) to a list
 * of responses served in order; the last one repeats. Every call is recorded.
 */
export function mockFetch(script) {
  const calls = [];
  const cursors = new Map();
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init.headers, body });
    if (typeof script === "function") return script(String(url), body, calls.length);
    const match = Object.keys(script).find((needle) => String(url).includes(needle));
    if (!match) throw new Error(`unexpected URL in test: ${url}`);
    const queue = [].concat(script[match]);
    const index = Math.min(cursors.get(match) ?? 0, queue.length - 1);
    cursors.set(match, index + 1);
    const step = queue[index];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(String(url), body) : step;
  };
  return { fetch, calls };
}

export const noSleep = async () => {};

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: { label: { type: "string" } }
};

export const KEYS = { apiKey: "sk-test-0123456789abcdef" }; // gitleaks:allow (fake test fixture)
