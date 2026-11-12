import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export type IoSource = "physical" | "logical" | "unavailable";

export function parseIo(text: string) {
  return Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
}

export function probeIo(directory: string): IoSource {
  let scratch: string | undefined;
  let fd: number | undefined;
  try {
    scratch = mkdtempSync(join(directory, ".io-probe-"));
    fd = openSync(join(scratch, "payload"), "w+");
    const before = parseIo(readFileSync("/proc/self/io", "utf8"));
    writeSync(fd, Buffer.alloc(65536));
    fsyncSync(fd);
    readFileSync(join(scratch, "payload"));
    const after = parseIo(readFileSync("/proc/self/io", "utf8"));
    if (after.write_bytes - before.write_bytes >= 65536) return "physical";
    if (after.wchar - before.wchar >= 65536 && after.rchar - before.rchar >= 65536) return "logical";
    return "unavailable";
  } catch {
    return "unavailable";
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

export function createIoTracker(source: IoSource) {
  const previous = new Map<number, { identity: string; read: number; write: number; at: number }>();
  return {
    sample(pid: number, identity: string, text: string, at: number) {
      const values = parseIo(text);
      const read = source === "physical" ? values.read_bytes : values.rchar;
      const write = source === "physical" ? values.write_bytes : values.wchar;
      if (source === "unavailable" || !Number.isFinite(read) || !Number.isFinite(write)) {
        previous.delete(pid);
        return { read: null, write: null, readRate: null, writeRate: null };
      }
      const old = previous.get(pid);
      previous.set(pid, { identity, read, write, at });
      const valid = old && old.identity === identity && at > old.at && read >= old.read && write >= old.write;
      const seconds = old ? (at - old.at) / 1000 : 0;
      return { read, write, readRate: valid ? (read - old.read) / seconds : null, writeRate: valid ? (write - old.write) / seconds : null };
    },
    prune(pids: Set<number>) {
      for (const pid of previous.keys()) if (!pids.has(pid)) previous.delete(pid);
    },
  };
}
