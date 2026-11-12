import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCache, directoryUsage } from "./storage";

test("cold requests return immediately and share one background scan", async () => {
  let finish!: (value: { updatedAt: string; inventory: { bytes: number } }) => void;
  let calls = 0;
  const cache = createStorageCache(() => {
    calls++;
    return new Promise<{ updatedAt: string; inventory: { bytes: number } }>((resolve) => { finish = resolve; });
  }, { intervalMs: 300_000 });
  const first = cache.snapshot();
  expect(first.inventory).toBeNull();
  expect(first.status).toBe("scanning");
  for (let i = 0; i < 20; i++) cache.snapshot();
  const pending = cache.refresh();
  await Promise.resolve();
  expect(calls).toBe(1);
  finish({ updatedAt: new Date().toISOString(), inventory: { bytes: 42 } });
  await pending;
  expect(cache.snapshot().status).toBe("ready");
  expect(cache.snapshot().inventory).toEqual({ bytes: 42 });
  expect(calls).toBe(1);
});

test("persisted results survive restart and stay visible while refreshing", async () => {
  const old = { updatedAt: new Date(0).toISOString(), inventory: { bytes: 12 } };
  let finish!: (value: typeof old) => void;
  let saved: typeof old | undefined;
  const cache = createStorageCache(
    () => new Promise<typeof old>((resolve) => { finish = resolve; }),
    { intervalMs: 100, now: () => 200, load: () => old, save: (value) => { saved = value; } },
  );
  const snapshot = cache.snapshot();
  expect(snapshot.inventory).toEqual(old.inventory);
  expect(snapshot.stale).toBe(true);
  expect(snapshot.refreshing).toBe(true);
  const pending = cache.refresh();
  await Promise.resolve();
  const fresh = { updatedAt: new Date(200).toISOString(), inventory: { bytes: 24 } };
  finish(fresh);
  await pending;
  expect(saved).toEqual(fresh);
  const restarted = createStorageCache(async () => { throw new Error("should not scan"); }, {
    intervalMs: 100, now: () => 250, load: () => saved,
  });
  expect(restarted.snapshot().inventory).toEqual(fresh.inventory);
  expect(restarted.snapshot().status).toBe("ready");
});

test("failed refresh preserves inventory and backs off before retrying", async () => {
  let now = 200, calls = 0;
  const old = { updatedAt: new Date(0).toISOString(), inventory: { bytes: 12 } };
  const cache = createStorageCache(async () => {
    calls++;
    throw new Error("scan timeout");
  }, { intervalMs: 100, retryMs: 50, now: () => now, load: () => old });
  await cache.refresh();
  const failed = cache.snapshot();
  expect(failed.inventory).toEqual(old.inventory);
  expect(failed.error).toBe("scan timeout");
  expect(failed.status).toBe("error");
  await cache.refresh();
  expect(calls).toBe(1);
  now = 251;
  await cache.refresh();
  expect(calls).toBe(2);
});

test("nested locations come from one traversal without losing child totals", async () => {
  const root = mkdtempSync(join(tmpdir(), "zo-storage-test-"));
  try {
    const nested = join(root, "nested"), leaf = join(nested, "leaf");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "payload"), Buffer.alloc(8192));
    linkSync(join(leaf, "payload"), join(root, "linked-payload"));
    const { sizes, incomplete } = await directoryUsage([root, nested, leaf, root]);
    expect(incomplete).toBe(false);
    expect(sizes.size).toBe(3);
    expect(sizes.get(leaf)).toBeGreaterThan(0);
    expect(sizes.get(root)).toBeGreaterThanOrEqual(sizes.get(nested)!);
    expect(sizes.get(nested)).toBeGreaterThanOrEqual(sizes.get(leaf)!);
    const expected = Bun.spawnSync(["du", "-sx", "-B1", root]);
    expect(sizes.get(root)).toBe(Number(new TextDecoder().decode(expected.stdout).split("\t")[0]));
    const empty = await directoryUsage([join(root, "missing")]);
    expect(empty.sizes.size).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery follows additions, renames and deletions, including unusual folder names", async () => {
  const root = mkdtempSync(join(tmpdir(), "zo-discovery-test-"));
  try {
    const before = await directoryUsage([root], 5000, 4);
    const folder = join(root, "new\nfolder");
    mkdirSync(folder);
    writeFileSync(join(folder, "payload"), Buffer.alloc(8192));
    const added = await directoryUsage([root], 5000, 4);
    expect(added.sizes.has(folder)).toBe(true);
    expect(added.sizes.get(root)).toBeGreaterThan(before.sizes.get(root)!);
    const moved = join(root, "renamed");
    renameSync(folder, moved);
    const renamed = await directoryUsage([root], 5000, 4);
    expect(renamed.sizes.has(folder)).toBe(false);
    expect(renamed.sizes.get(moved)).toBe(added.sizes.get(folder));
    rmSync(moved, { recursive: true });
    const deleted = await directoryUsage([root], 5000, 4);
    expect(deleted.sizes.has(moved)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual scans refresh fresh data while sharing work and limiting repeated starts", async () => {
  let now = 100_000, calls = 0;
  const cache = createStorageCache(async () => {
    calls++;
    return { updatedAt: new Date(now).toISOString() };
  }, { intervalMs: 300_000, now: () => now, load: () => ({ updatedAt: new Date(now).toISOString() }) });
  await cache.refresh();
  expect(calls).toBe(0);
  const first = cache.refresh(true);
  expect(cache.refresh(true)).toBe(first);
  await first;
  expect(calls).toBe(1);
  await cache.refresh(true);
  expect(calls).toBe(1);
  now += 30_001;
  await cache.refresh(true);
  expect(calls).toBe(2);
});
