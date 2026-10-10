/**
 * Directory-backed answer cache for Node. Kept out of the core entry so the
 * router itself never imports node:fs and runs on edge runtimes.
 *
 *   import { fileCache } from "fail-closed-router/file-cache";
 *   const cache = fileCache(".answer-cache", { ttlMs: 14 * 86_400_000 });
 *
 * Entries are written atomically (temp file, then rename) and sharded by the
 * first two hex characters of the key. A read error or an expired entry is a
 * miss; a write error is swallowed by the router.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FORMAT = "fcr-file-cache-v1";

/**
 * @param {string} dir
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function fileCache(dir, { ttlMs = Infinity, now = Date.now } = {}) {
  if (typeof dir !== "string" || !dir) throw new TypeError("fileCache(dir) needs a directory path");
  const fileFor = (key) => {
    if (!/^[a-f0-9]{16,}$/.test(key)) throw new Error("cache keys must be lowercase hex");
    return path.join(dir, key.slice(0, 2), `${key}.json`);
  };
  let counter = 0;
  return {
    dir,
    async get(key) {
      try {
        const row = JSON.parse(await readFile(fileFor(key), "utf8"));
        if (row?.format !== FORMAT || row.value === undefined) return undefined;
        if (now() - Number(row.storedAt) > ttlMs) return undefined;
        return row.value;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      const target = fileFor(key);
      await mkdir(path.dirname(target), { recursive: true });
      counter += 1;
      const temp = `${target}.${globalThis.process?.pid ?? 0}.${counter}.tmp`;
      await writeFile(temp, JSON.stringify({ format: FORMAT, storedAt: now(), value }));
      await rename(temp, target);
    }
  };
}
