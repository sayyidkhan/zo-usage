import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIoTracker, probeIo } from "./io";

test("logical fallback measures activity when physical counters stay zero", () => {
  const tracker = createIoTracker("logical");
  const first = tracker.sample(1, "start", "rchar: 100\nwchar: 200\nread_bytes: 0\nwrite_bytes: 0", 1000);
  expect(first.readRate).toBeNull();
  const second = tracker.sample(1, "start", "rchar: 300\nwchar: 600\nread_bytes: 0\nwrite_bytes: 0", 3000);
  expect(second).toEqual({ read: 300, write: 600, readRate: 100, writeRate: 200 });
});

test("missing counters differ from idle; PID reuse and resets need a new baseline", () => {
  const tracker = createIoTracker("physical");
  expect(tracker.sample(1, "a", "", 0).read).toBeNull();
  tracker.sample(1, "a", "read_bytes: 500\nwrite_bytes: 800", 1000);
  expect(tracker.sample(1, "a", "read_bytes: 500\nwrite_bytes: 800", 2000).readRate).toBe(0);
  expect(tracker.sample(1, "b", "read_bytes: 1000\nwrite_bytes: 1200", 3000).readRate).toBeNull();
  expect(tracker.sample(1, "b", "read_bytes: 0\nwrite_bytes: 0", 4000).readRate).toBeNull();
  tracker.prune(new Set());
  expect(tracker.sample(1, "b", "read_bytes: 200\nwrite_bytes: 200", 5000).readRate).toBeNull();
  expect(createIoTracker("unavailable").sample(1, "a", "rchar: 0\nwchar: 0", 0).read).toBeNull();
});

test("capability probe verifies actual I/O and cleans up", () => {
  const directory = mkdtempSync(join(tmpdir(), "zo-io-test-"));
  try {
    expect(["physical", "logical", "unavailable"]).toContain(probeIo(directory));
    expect(probeIo(join(directory, "missing"))).toBe("unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
