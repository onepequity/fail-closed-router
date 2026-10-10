/**
 * Failure classification.
 *
 * Every error raised while calling a provider is mapped to one failure class.
 * Only the infrastructure classes in INFRA_FAILURES may advance a lane to its
 * next route. Everything else (bad output, refusals, rejected requests,
 * unknown errors) stops the chain.
 */

export const INFRA_FAILURES = Object.freeze(["authentication", "quota", "rate_limit", "provider_unavailable", "timeout"]);

const QUOTA = /insufficient_quota|quota|usage limit|billing|credit balance|exceeded your current/;
const TIMEOUT = /timed out|timeout|etimedout|operation was aborted|aborterror|timeouterror/;
const AUTH = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|invalid api key|api key|credential/;
const RATE = /\b429\b|rate.?limit|too many requests/;
const UNAVAILABLE = /\b5\d\d\b|\b404\b|unavailable|overloaded|fetch failed|network|connection|econnreset|econnrefused|econnaborted|enotfound|ehostunreach|enetunreach|epipe|socket hang up|model not found|model_not_found|no such model|unknown model/;
const BAD_REQUEST = /\b400\b|\b422\b|bad request|invalid_request/;
const MALFORMED = /malformed|no content|invalid json|unexpected token|schema|validation/;

/**
 * Map an HTTP status (plus the response text, for quota detection) to a class.
 * @param {number} status
 * @param {string} [text]
 */
export function classifyStatus(status, text = "") {
  const lower = String(text).toLowerCase();
  if (status === 429) return QUOTA.test(lower) ? "quota" : "rate_limit";
  if (status === 402) return "quota";
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 404) return "provider_unavailable";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500 && status <= 599) return "provider_unavailable";
  return "unknown";
}

/**
 * Classify any thrown value into a failure class.
 *
 * Precedence: an explicit `failureClass` on the error, then an HTTP `status`,
 * then the error name (AbortError / TimeoutError), then message patterns.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function classifyProviderFailure(error) {
  if (error && typeof error === "object") {
    if (typeof error.failureClass === "string") return error.failureClass;
    if (Number.isInteger(error.status)) return classifyStatus(error.status, error.body || error.message);
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
  }
  const message = String(error?.message ?? error).toLowerCase();
  if (QUOTA.test(message)) return "quota";
  if (TIMEOUT.test(message)) return "timeout";
  if (AUTH.test(message)) return "authentication";
  if (RATE.test(message)) return "rate_limit";
  if (BAD_REQUEST.test(message)) return "bad_request";
  if (UNAVAILABLE.test(message)) return "provider_unavailable";
  if (MALFORMED.test(message)) return "malformed_output";
  return "unknown";
}

/**
 * @param {string} failureClass
 * @param {readonly string[]} [eligible]
 */
export function isFallbackEligible(failureClass, eligible = INFRA_FAILURES) {
  return eligible.includes(failureClass);
}

/** Remove credentials from a message before it is stored or rethrown. */
export function redact(message, secrets = []) {
  let text = String(message ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/Bearer\s+[^\s"',]+/gi, "Bearer [REDACTED]")
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}
