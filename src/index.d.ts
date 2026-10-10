export type FailureClass =
  | "authentication"
  | "quota"
  | "rate_limit"
  | "provider_unavailable"
  | "timeout"
  | "bad_request"
  | "malformed_output"
  | "model_refusal"
  | "validator_rejected"
  | "validator_error"
  | "aborted"
  | "unknown"
  | (string & {});

export type BuiltinProvider = "openai" | "anthropic" | "xai";

export interface Capabilities {
  /** The endpoint enforces a strict JSON schema on the reply. */
  jsonSchema?: boolean;
  /** The endpoint accepts a temperature override. */
  temperature?: boolean;
}

export interface Route {
  provider: BuiltinProvider | (string & {});
  model: string;
  /** A key, or a function that resolves one. Takes precedence over credentialEnv. */
  apiKey?: string | (() => string | undefined | Promise<string | undefined>);
  /** Environment variable name(s) to read the key from, in order. */
  credentialEnv?: string | string[];
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** true asserts the leg is pinned (validated at startup); false opts out; omitted derives it. */
  pinned?: boolean;
  /** Switch transport capabilities off for this route (never on). */
  capabilities?: Capabilities;
  [extra: string]: unknown;
}

export interface TransportInput {
  route: Route;
  apiKey: string;
  prompt: string;
  system: string | null;
  schema: object | null;
  schemaName: string;
  strict: boolean;
  capabilities: Required<Capabilities>;
}

export interface ParsedReply {
  /** Raw model text; parsed as JSON by the router. */
  content?: string | null;
  /** Already-parsed data; skips JSON parsing. */
  data?: unknown;
  refusal?: string | null;
  usage?: unknown;
}

export interface HttpTransport {
  capabilities?: Capabilities;
  buildRequest(input: TransportInput): { url: string; headers: Record<string, string>; body: string };
  parseResponse(json: any): ParsedReply;
}

export interface CallTransport {
  capabilities?: Capabilities;
  call(input: TransportInput & { signal: AbortSignal; fetch: typeof fetch }): Promise<ParsedReply>;
}

export type Transport = HttpTransport | CallTransport;

export interface AnswerCache {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown): unknown | Promise<unknown>;
}

export type LockEntry = string | [string, string] | { provider: string; model: string };

export interface RouterOptions {
  lanes: Record<string, Route[]>;
  lock?: Record<string, LockEntry[]>;
  cache?: AnswerCache | null;
  fetch?: typeof fetch;
  transports?: Record<string, Transport>;
  /** Source for credentialEnv lookups. Defaults to process.env when present. */
  env?: Record<string, string | undefined>;
  /** Per-request timeout. Default 60000. */
  timeoutMs?: number;
  /** 429 retry policy. Default { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 15000 }. */
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  /** Test hook for retry delays. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export type Verdict = boolean | void | undefined | { ok: true } | { ok: false; reason?: string; correction?: string };

export interface RunJsonInput<T = unknown> {
  lane: string;
  prompt: string;
  system?: string | null;
  schema?: object | null;
  schemaName?: string;
  strict?: boolean;
  validate?: (data: T, meta: { provider: string; model: string; pinned: boolean }) => Verdict | Promise<Verdict>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Attempt {
  provider: string;
  model: string;
  failureClass: FailureClass;
  status: number | null;
  message: string;
}

export interface CorrectedRetry {
  attempted: boolean;
  outcome: "served" | "no_pinned_leg" | "unavailable";
  reason: string;
  fromProvider: string;
  fromModel: string;
  correction?: string;
  failureClass?: FailureClass;
  provider?: string;
  model?: string;
}

export interface RunJsonResult<T = unknown> {
  data: T;
  provider: string;
  model: string;
  routeIndex: number;
  pinned: boolean;
  usage: unknown;
  attempts: Attempt[];
  accepted: boolean;
  rejection: { reason: string } | null;
  correctedRetry: CorrectedRetry | null;
  cache: { hit: boolean; key: string } | null;
}

export interface Router {
  readonly lanes: Readonly<Record<string, readonly Route[]>>;
  runJson<T = unknown>(input: RunJsonInput<T>): Promise<RunJsonResult<T>>;
}

export function createRouter(options: RouterOptions): Router;
export function isPinnedRoute(route: Route, schema: object | null | undefined, options?: { transport?: Transport; strict?: boolean }): boolean;
export function validateLock(lanes: Record<string, Route[]>, lock: Record<string, LockEntry[]>): true;
export function classifyProviderFailure(error: unknown): FailureClass;
export function classifyStatus(status: number, text?: string): FailureClass;
export function isFallbackEligible(failureClass: string, eligible?: readonly string[]): boolean;
export function redact(message: unknown, secrets?: Array<string | null | undefined>): string;
export const INFRA_FAILURES: readonly FailureClass[];

export function memoryCache(options?: { maxEntries?: number }): AnswerCache & { readonly size: number; clear(): void };
export function answerKey(input: { lane: string; routes?: Route[]; system?: string | null; prompt?: string; schema?: object | null; schemaName?: string | null; strict?: boolean }): Promise<string>;
export function canonicalJson(value: unknown): string;
export const CACHE_KEY_VERSION: string;

export const builtinTransports: Readonly<Record<BuiltinProvider, HttpTransport>>;
export function routeCapabilities(route: Route, transport?: Transport): Required<Capabilities>;

export class RouterError extends Error {
  attempts: Attempt[];
  failureClass: FailureClass | null;
}
export class ConfigError extends Error {}
export class ProviderError extends Error {
  status?: number;
  failureClass?: FailureClass;
}
