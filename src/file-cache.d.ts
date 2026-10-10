import type { AnswerCache } from "./index.js";

export function fileCache(dir: string, options?: { ttlMs?: number; now?: () => number }): AnswerCache & { readonly dir: string };
