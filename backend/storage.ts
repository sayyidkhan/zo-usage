import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

export async function directoryUsage(paths: string[], timeoutMs = 120_000, discoverDepth = 0) {
  const existing = [...new Set(paths.map((path) => resolve(path)))].filter(
    (path) => existsSync(path),
  );
  if (!existing.length) return { sizes: new Map<string, number>(), incomplete: false };
  const roots = existing.filter(
    (path) => !existing.some((parent) => path.startsWith(parent + "/")),
  );
  const depth = Math.max(
    discoverDepth,
    ...existing.map((path) => {
      const root = roots.find((root) => path === root || path.startsWith(root + "/"))!;
      const child = relative(root, path);
      return child ? child.split("/").length : 0;
    }),
  );
  const child = Bun.spawn(
    ["/usr/bin/du", "-x", "-B1", "--null", "--max-depth=" + depth, "--", ...roots],
    { stdout: "pipe", stderr: "ignore" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error("Storage scan exceeded its time limit");
    const sizes = new Map<string, number>();
    const requested = new Set(existing);
    for (const line of output.split("\0")) {
      const match = line.match(/^(\d+)\t([\s\S]+)$/);
      if (match && (discoverDepth > 0 || requested.has(match[2]))) sizes.set(match[2], Number(match[1]));
    }
    if (exitCode > 1 || roots.some((root) => !sizes.has(root))) {
      throw new Error("Storage scan could not read the configured locations");
    }
    return { sizes, incomplete: exitCode !== 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function createStorageCache<T extends { updatedAt: string }>(
  scan: () => Promise<T>,
  options: {
    intervalMs: number;
    retryMs?: number;
    load?: () => T | undefined;
    save?: (value: T) => void;
    now?: () => number;
  },
) {
  const now = options.now || Date.now;
  let cached: T | undefined;
  let pending: Promise<void> | undefined;
  let lastError: string | undefined;
  let retryAt = 0;
  try {
    cached = options.load?.();
    if (cached && !Number.isFinite(Date.parse(cached.updatedAt))) cached = undefined;
  } catch (error) {
    console.error("Unable to load saved storage inventory", error);
  }
  function stale() {
    return !cached || now() - Date.parse(cached.updatedAt) >= options.intervalMs;
  }
  let lastStartedAt = -Infinity;
  function refresh(force = false) {
    if (pending) return pending;
    if (now() < retryAt || (force && now() - lastStartedAt < 30_000)) return Promise.resolve();
    if (!force && !stale()) return Promise.resolve();
    lastStartedAt = now();
    pending = Promise.resolve()
      .then(scan)
      .then((value) => {
        cached = value;
        lastError = undefined;
        try {
          options.save?.(value);
        } catch (error) {
          console.error("Unable to save storage inventory", error);
        }
      })
      .catch((error) => {
        lastError = error instanceof Error ? error.message : "Storage scan failed";
        retryAt = now() + (options.retryMs ?? 60_000);
        console.error("Storage inventory refresh failed", error);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  return {
    refresh,
    snapshot() {
      void refresh();
      return {
        ...(cached || { inventory: null }),
        status: pending ? "scanning" : lastError ? "error" : "ready",
        refreshing: Boolean(pending),
        stale: stale(),
        error: lastError || null,
      };
    },
  };
}
