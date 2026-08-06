import { cpus, loadavg } from "node:os";
import { readFileSync, readlinkSync } from "node:fs";

type Counter = { total: number; idle: number; at: number };
type Bytes = { received: number; sent: number; receivedPackets: number; sentPackets: number; at: number };
type Io = { read: number; write: number; at: number };
type ManagedService = { pid: number; name: string };

const port = Number(process.env.PORT || "8791");
const basePath = (process.env.APP_BASE_PATH || "/usage").replace(/\/$/, "");
const history: Array<{ at: number; cpu: number; memory: number }> = [];
const processIo = new Map<number, Io>();
let cpuPrevious: Counter | undefined;
let networkPrevious: Bytes | undefined;
let cached: ReturnType<typeof collect> | undefined;
let cachedAt = 0;
let managedServices: ManagedService[] = [];
let managedServicesAt = 0;

function manifestApplications(path: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { applications?: unknown };
  if (!manifest.applications || typeof manifest.applications !== "object" || Array.isArray(manifest.applications)) {
    throw new Error('Manifest must contain an "applications" object');
  }
  return Object.fromEntries(
    Object.entries(manifest.applications).filter(([service, label]) => service.trim() && typeof label === "string" && label.trim())
  ) as Record<string, string>;
}

function loadApplicationNames() {
  const bundledPath = `${import.meta.dir}/application-manifest.json`;
  let names: Record<string, string> = {};
  try {
    names = manifestApplications(bundledPath);
  } catch (error) {
    console.warn(`Unable to load bundled application manifest: ${error}`);
  }

  const overridePath = process.env.APPLICATION_MANIFEST_PATH;
  if (!overridePath) return names;
  try {
    return { ...names, ...manifestApplications(overridePath) };
  } catch (error) {
    console.warn(`Unable to load application manifest override at ${overridePath}: ${error}`);
    return names;
  }
}

const applicationNames = loadApplicationNames();

function number(value: string | undefined): number {
  return Number(value || "0");
}

function readMemory() {
  const values = Object.fromEntries(
    readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .map((line) => line.match(/^(\w+):\s+(\d+)/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], number(match[2]) * 1024])
  ) as Record<string, number>;
  const total = values.MemTotal || 0;
  const available = values.MemAvailable ?? values.MemFree ?? 0;
  const used = Math.max(0, total - available);
  const shared = values.Shmem || 0;
  const fileCache = Math.max(0, (values.Cached || 0) + (values.Buffers || 0) + (values.SReclaimable || 0) - shared);
  const kernelKeys = ["SUnreclaim", "KernelStack", "PageTables"];
  const kernelKnown = kernelKeys.some((key) => key in values);
  const kernel = kernelKeys.reduce((sum, key) => sum + (values[key] || 0), 0);
  const swapTotal = values.SwapTotal || 0;
  const swapUsed = Math.max(0, swapTotal - (values.SwapFree || 0));
  return { total, used, available, fileCache, kernel, kernelKnown, shared, swapTotal, swapUsed };
}

function readCpu() {
  const now = Date.now();
  try {
    const usage = number(readFileSync("/sys/fs/cgroup/cpuacct/cpuacct.usage", "utf8").trim());
    const previous = cpuPrevious;
    cpuPrevious = { total: usage, idle: 0, at: now };
    if (!previous || usage < previous.total || now <= previous.at) return 0;
    const available = (now - previous.at) * 1_000_000 * cpus().length;
    return Math.max(0, Math.min(100, 100 * (usage - previous.total) / available));
  } catch {
    // Fall back to procfs on hosts without the cgroup CPU accounting counter.
  }
  const values = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(number);
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = (values[3] || 0) + (values[4] || 0);
  const previous = cpuPrevious;
  cpuPrevious = { total, idle, at: now };
  if (!previous || total <= previous.total) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - (idle - previous.idle) / (total - previous.total))));
}

function readNetwork() {
  const totals = readFileSync("/proc/net/dev", "utf8")
    .split("\n")
    .slice(2)
    .map((line) => line.trim().split(/[:\s]+/))
    .filter((parts) => parts.length > 9 && parts[0] !== "lo")
    .reduce(
      (sum, parts) => ({ received: sum.received + number(parts[1]), sent: sum.sent + number(parts[9]), receivedPackets: sum.receivedPackets + number(parts[2]), sentPackets: sum.sentPackets + number(parts[10]) }),
      { received: 0, sent: 0, receivedPackets: 0, sentPackets: 0 }
    );
  const now = Date.now();
  const previous = networkPrevious;
  networkPrevious = { ...totals, at: now };
  if (!previous || now <= previous.at) return { ...totals, down: 0, up: 0, downPackets: 0, upPackets: 0 };
  const seconds = (now - previous.at) / 1000;
  return {
    down: Math.max(0, (totals.received - previous.received) / seconds),
    up: Math.max(0, (totals.sent - previous.sent) / seconds),
    downPackets: Math.max(0, (totals.receivedPackets - previous.receivedPackets) / seconds),
    upPackets: Math.max(0, (totals.sentPackets - previous.sentPackets) / seconds),
    ...totals
  };
}

function readDisk() {
  const output = new TextDecoder().decode(Bun.spawnSync(["df", "-B1", "/"]).stdout).trim().split("\n")[1]?.trim().split(/\s+/) || [];
  const total = number(output[1]);
  const used = number(output[2]);
  return { total, used, available: number(output[3]) };
}

function diskActivity(pid: number) {
  try {
    const values = Object.fromEntries(
      readFileSync(`/proc/${pid}/io`, "utf8")
        .split("\n")
        .map((line) => line.match(/^(read_bytes|write_bytes):\s+(\d+)/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => [match[1], number(match[2])])
    ) as Record<string, number>;
    const now = Date.now();
    const current = { read: values.read_bytes || 0, write: values.write_bytes || 0, at: now };
    const previous = processIo.get(pid);
    processIo.set(pid, current);
    if (!previous || now <= previous.at) return { ...current, readRate: 0, writeRate: 0 };
    const seconds = (now - previous.at) / 1000;
    return { ...current, readRate: Math.max(0, (current.read - previous.read) / seconds), writeRate: Math.max(0, (current.write - previous.write) / seconds) };
  } catch {
    return { read: 0, write: 0, at: Date.now(), readRate: 0, writeRate: 0 };
  }
}

function serviceRoots() {
  if (Date.now() - managedServicesAt < 15_000) return managedServices;
  const output = new TextDecoder().decode(
    Bun.spawnSync(["supervisorctl", "-c", "/etc/zo/supervisord-user.conf", "status"]).stdout
  );
  managedServices = output
    .split("\n")
    .map((line) => line.match(/^(\S+)\s+\S+\s+pid\s+(\d+)/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ name: match[1], pid: number(match[2]) }));
  managedServicesAt = Date.now();
  return managedServices;
}

function parentPid(pid: number) {
  try {
    return number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m)?.[1]);
  } catch {
    return 0;
  }
}

function workingDirectory(pid: number) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

function workspaceApplication(cwd: string) {
  const garden = cwd.match(/\/Start\/garden-of-zo\/([^/]+)/)?.[1];
  if (garden) return applicationNames[garden] || garden.replace(/[-_]+/g, " ");
  const hackathon = cwd.match(/\/hackathon\/[^/]+\/([^/]+)/)?.[1];
  if (hackathon) return `${hackathon.replace(/[-_]+/g, " ")} (hackathon)`;
  return "";
}

function applicationFor(pid: number, initialParent: number, name: string, args: string) {
  const roots = new Map(serviceRoots().map((service) => [service.pid, service.name]));
  let current = pid;
  let parent = initialParent;
  for (let depth = 0; depth < 12 && current > 1; depth += 1) {
    const service = roots.get(current);
    if (service) return { application: applicationNames[service] || service, role: "Zo service" };
    current = parent;
    parent = parentPid(current);
  }
  if (name.includes("chrome") || args.includes("agent-browser")) return { application: "Zo Browser", role: "Browser session" };
  if (["zsh", "bash", "sh", "curl", "jq", "sleep"].includes(name)) return { application: "Developer session", role: "Terminal command" };
  const fromWorkspace = workspaceApplication(workingDirectory(pid));
  if (fromWorkspace) return { application: fromWorkspace, role: "Workspace application" };
  if (name === "loki") return { application: "Zo Platform", role: "Log storage" };
  if (name === "promtail") return { application: "Zo Platform", role: "Log collection" };
  if (name.startsWith("next-server")) return { application: "Zo Platform", role: "Web application" };
  if (args.includes("mcpo")) return { application: "Zo Platform", role: "Tool gateway" };
  if (name === "sshd" || name === "frpc") return { application: "Zo Platform", role: "Secure connectivity" };
  if (workingDirectory(pid).startsWith("/__modal/")) return { application: "Zo Platform", role: "Workspace server" };
  if (name === "modal-daemon" || name === "dumb-init") return { application: "Zo Platform", role: "Container runtime" };
  if (name.includes("codex") || args.includes("/codex")) return { application: "Codex", role: "Development assistant" };
  if (name === "supervisord") return { application: "Zo Platform", role: "Service supervisor" };
  return { application: "Unattributed process", role: "System process" };
}

function processes() {
  const output = new TextDecoder().decode(
    Bun.spawnSync(["ps", "-eo", "pid=,ppid=,pcpu=,pmem=,rss=,etimes=,nlwp=,comm=,args=", "--sort=-pcpu"]).stdout
  );
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const pid = number(match[1]);
      const parent = number(match[2]);
      const name = match[8];
      const args = match[9];
      const io = diskActivity(pid);
      return {
        pid,
        cpu: number(match[3]),
        memoryPercent: number(match[4]),
        memory: number(match[5]) * 1024,
        elapsed: number(match[6]),
        threads: number(match[7]),
        name,
        ...applicationFor(pid, parent, name, args),
        diskRead: io.read,
        diskWrite: io.write,
        diskReadRate: io.readRate,
        diskWriteRate: io.writeRate,
        disk: io.readRate + io.writeRate
      };
    })
    .filter((process) => process.name !== "ps");
}

function networkConnections(processList: ReturnType<typeof processes>) {
  const byPid = new Map(processList.map((process) => [process.pid, process]));
  const output = new TextDecoder().decode(Bun.spawnSync(["ss", "-tunapH"]).stdout);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/, 6);
      const pid = number(line.match(/pid=(\d+)/)?.[1]);
      const process = byPid.get(pid);
      return {
        pid,
        application: process?.application || "Zo Platform",
        role: process?.role || "Network service",
        name: process?.name || "socket",
        protocol: parts[0] || "unknown",
        state: parts[1] || "unknown",
        local: parts[4] || "",
        remote: parts[5] || ""
      };
    })
    .filter((connection) => connection.pid > 0)
    .sort((a, b) => (a.state === "LISTEN" ? -1 : 0) - (b.state === "LISTEN" ? -1 : 0) || a.application.localeCompare(b.application));
}

function collect() {
  const processList = processes();
  const memory = { ...readMemory(), processResident: processList.reduce((sum, process) => sum + process.memory, 0) };
  const disk = {
    ...readDisk(),
    trackedRead: processList.reduce((sum, process) => sum + process.diskRead, 0),
    trackedWrite: processList.reduce((sum, process) => sum + process.diskWrite, 0),
    readRate: processList.reduce((sum, process) => sum + process.diskReadRate, 0),
    writeRate: processList.reduce((sum, process) => sum + process.diskWriteRate, 0)
  };
  const cpu = readCpu();
  const snapshot = {
    updatedAt: new Date().toISOString(),
    cores: cpus().length,
    cpu,
    load: loadavg(),
    memory,
    disk,
    network: readNetwork(),
    processes: processList,
    connections: networkConnections(processList)
  };
  history.push({ at: Date.now(), cpu, memory: memory.total ? (memory.used / memory.total) * 100 : 0 });
  if (history.length > 72) history.shift();
  return { ...snapshot, history };
}

function snapshot() {
  if (!cached || Date.now() - cachedAt > 1500) {
    cached = collect();
    cachedAt = Date.now();
  }
  return cached;
}

function frontendAsset(name: string) {
  return readFileSync(`${import.meta.dir}/../frontend/${name}`, "utf8").replaceAll("__APP_BASE_PATH__", basePath);
}

function frontendResponse(name: string, contentType: string, cacheControl = "no-store") {
  return new Response(frontendAsset(name), {
    headers: { "content-type": contentType, "cache-control": cacheControl }
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `${basePath}/favicon.svg`) {
      return frontendResponse("favicon.svg", "image/svg+xml", "public, max-age=86400");
    }
    if (url.pathname === `${basePath}/api/snapshot`) {
      return Response.json(snapshot(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === `${basePath}/assets/styles.css`) {
      return frontendResponse("styles.css", "text/css; charset=utf-8");
    }
    if (url.pathname === `${basePath}/assets/app.js`) {
      return frontendResponse("app.js", "text/javascript; charset=utf-8");
    }
    if (url.pathname === basePath || url.pathname === `${basePath}/`) {
      return frontendResponse("index.html", "text/html; charset=utf-8");
    }
    return new Response("Not found", { status: 404 });
  }
});
