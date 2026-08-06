import { cpus, loadavg } from "node:os";
import { mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

type Counter = { total: number; idle: number; at: number };
type Bytes = { received: number; sent: number; receivedPackets: number; sentPackets: number; at: number };
type Io = { read: number; write: number; at: number };
type ManagedService = { pid: number; name: string };

const port = Number(process.env.PORT || "8791");
const basePath = (process.env.APP_BASE_PATH || "/usage").replace(/\/$/, "");
const databasePath = process.env.USAGE_HISTORY_DATABASE_PATH || `${import.meta.dir}/data/usage-history.sqlite`;
const history: Array<{ at: number; cpu: number; memory: number }> = [];
const processIo = new Map<number, Io>();
let cpuPrevious: Counter | undefined;
let networkPrevious: Bytes | undefined;
let cached: ReturnType<typeof collect> | undefined;
let cachedAt = 0;
let managedServices: ManagedService[] = [];
let managedServicesAt = 0;
let historyPrunedAt = 0;

mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath, { create: true });
database.run("PRAGMA journal_mode = WAL");
database.run("PRAGMA busy_timeout = 5000");
database.run(`
  CREATE TABLE IF NOT EXISTS network_samples (
    at INTEGER PRIMARY KEY,
    received_bytes INTEGER NOT NULL,
    sent_bytes INTEGER NOT NULL,
    received_packets INTEGER NOT NULL,
    sent_packets INTEGER NOT NULL,
    received_delta INTEGER NOT NULL,
    sent_delta INTEGER NOT NULL,
    received_packets_delta INTEGER NOT NULL,
    sent_packets_delta INTEGER NOT NULL
  )
`);
database.run(`
  CREATE TABLE IF NOT EXISTS network_daily (
    day TEXT PRIMARY KEY,
    received_bytes INTEGER NOT NULL,
    sent_bytes INTEGER NOT NULL,
    received_packets INTEGER NOT NULL,
    sent_packets INTEGER NOT NULL
  )
`);
database.run(`
  CREATE TABLE IF NOT EXISTS application_traffic_samples (
    at INTEGER NOT NULL,
    application TEXT NOT NULL,
    received_bytes INTEGER NOT NULL,
    sent_bytes INTEGER NOT NULL,
    request_count INTEGER NOT NULL,
    error_count INTEGER NOT NULL,
    PRIMARY KEY (at, application)
  )
`);
database.run(`
  CREATE TABLE IF NOT EXISTS application_traffic_daily (
    day TEXT NOT NULL,
    application TEXT NOT NULL,
    received_bytes INTEGER NOT NULL,
    sent_bytes INTEGER NOT NULL,
    request_count INTEGER NOT NULL,
    error_count INTEGER NOT NULL,
    PRIMARY KEY (day, application)
  )
`);
database.run("CREATE INDEX IF NOT EXISTS network_samples_at ON network_samples(at)");
database.run("CREATE INDEX IF NOT EXISTS application_traffic_samples_at ON application_traffic_samples(at)");

function singaporeDate(at: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(at));
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function totals(rows: Array<{ receivedBytes: number; sentBytes: number; receivedPackets: number; sentPackets: number }>) {
  return rows.reduce(
    (sum, row) => ({
      receivedBytes: sum.receivedBytes + row.receivedBytes,
      sentBytes: sum.sentBytes + row.sentBytes,
      receivedPackets: sum.receivedPackets + row.receivedPackets,
      sentPackets: sum.sentPackets + row.sentPackets
    }),
    { receivedBytes: 0, sentBytes: 0, receivedPackets: 0, sentPackets: 0 }
  );
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

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

function readNetworkTotals() {
  return readFileSync("/proc/net/dev", "utf8")
    .split("\n")
    .slice(2)
    .map((line) => line.trim().split(/[:\s]+/))
    .filter((parts) => parts.length > 9 && parts[0] !== "lo")
    .reduce(
      (sum, parts) => ({ received: sum.received + number(parts[1]), sent: sum.sent + number(parts[9]), receivedPackets: sum.receivedPackets + number(parts[2]), sentPackets: sum.sentPackets + number(parts[10]) }),
      { received: 0, sent: 0, receivedPackets: 0, sentPackets: 0 }
    );
}

function recordBandwidth() {
  const at = Math.floor(Date.now() / 60_000) * 60_000;
  const exists = database.query("SELECT 1 FROM network_samples WHERE at = ?").get(at);
  if (exists) return;

  const current = readNetworkTotals();
  const previous = database.query("SELECT received_bytes, sent_bytes, received_packets, sent_packets FROM network_samples ORDER BY at DESC LIMIT 1").get() as {
    received_bytes: number;
    sent_bytes: number;
    received_packets: number;
    sent_packets: number;
  } | null;
  const receivedDelta = previous && current.received >= previous.received_bytes ? current.received - previous.received_bytes : 0;
  const sentDelta = previous && current.sent >= previous.sent_bytes ? current.sent - previous.sent_bytes : 0;
  const receivedPacketsDelta = previous && current.receivedPackets >= previous.received_packets ? current.receivedPackets - previous.received_packets : 0;
  const sentPacketsDelta = previous && current.sentPackets >= previous.sent_packets ? current.sentPackets - previous.sent_packets : 0;
  const day = singaporeDate(at);

  database.query(`
    INSERT INTO network_samples (
      at, received_bytes, sent_bytes, received_packets, sent_packets,
      received_delta, sent_delta, received_packets_delta, sent_packets_delta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(at, current.received, current.sent, current.receivedPackets, current.sentPackets, receivedDelta, sentDelta, receivedPacketsDelta, sentPacketsDelta);
  database.query(`
    INSERT INTO network_daily (day, received_bytes, sent_bytes, received_packets, sent_packets)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      received_bytes = received_bytes + excluded.received_bytes,
      sent_bytes = sent_bytes + excluded.sent_bytes,
      received_packets = received_packets + excluded.received_packets,
      sent_packets = sent_packets + excluded.sent_packets
  `).run(day, receivedDelta, sentDelta, receivedPacketsDelta, sentPacketsDelta);

  if (Date.now() - historyPrunedAt > 24 * 60 * 60 * 1000) {
    database.query("DELETE FROM network_samples WHERE at < ?").run(Date.now() - 30 * 24 * 60 * 60 * 1000);
    database.query("DELETE FROM network_daily WHERE day < ?").run(singaporeDate(Date.now() - 365 * 24 * 60 * 60 * 1000));
    database.query("DELETE FROM application_traffic_samples WHERE at < ?").run(Date.now() - 30 * 24 * 60 * 60 * 1000);
    database.query("DELETE FROM application_traffic_daily WHERE day < ?").run(singaporeDate(Date.now() - 365 * 24 * 60 * 60 * 1000));
    historyPrunedAt = Date.now();
  }
}

function bandwidthHistory() {
  const now = Date.now();
  const today = singaporeDate(now);
  const month = today.slice(0, 7);
  const since = singaporeDate(now - 29 * 24 * 60 * 60 * 1000);
  const rows = database.query(`
    SELECT day,
      received_bytes AS receivedBytes,
      sent_bytes AS sentBytes,
      received_packets AS receivedPackets,
      sent_packets AS sentPackets
    FROM network_daily
    WHERE day >= ?
    ORDER BY day DESC
  `).all(since) as Array<{ day: string; receivedBytes: number; sentBytes: number; receivedPackets: number; sentPackets: number }>;
  const all = database.query(`
    SELECT day,
      received_bytes AS receivedBytes,
      sent_bytes AS sentBytes,
      received_packets AS receivedPackets,
      sent_packets AS sentPackets
    FROM network_daily
    WHERE day >= ?
    ORDER BY day DESC
  `).all(`${month}-01`) as Array<{ day: string; receivedBytes: number; sentBytes: number; receivedPackets: number; sentPackets: number }>;
  const todayRows = rows.filter((row) => row.day === today);
  const connectionOwners = [...snapshot().connections.reduce((owners, connection) => {
    owners.set(connection.application, (owners.get(connection.application) || 0) + 1);
    return owners;
  }, new Map<string, number>())]
    .map(([application, connections]) => ({ application, connections }))
    .sort((a, b) => b.connections - a.connections || a.application.localeCompare(b.application))
    .slice(0, 3);
  return {
    updatedAt: new Date().toISOString(),
    today: totals(todayRows),
    month: totals(all),
    last30Days: totals(rows),
    daily: rows,
    connectionOwners,
    detailedRetentionDays: 30,
    dailyRetentionDays: 365
  };
}

async function ingestApplicationTraffic(request: Request) {
  try {
    const payload = await request.json() as { samples?: unknown };
    if (!Array.isArray(payload.samples) || payload.samples.length > 64) {
      return Response.json({ error: "samples must be an array of up to 64 entries" }, { status: 400 });
    }

    let accepted = 0;
    for (const sample of payload.samples) {
      if (!sample || typeof sample !== "object") continue;
      const value = sample as Record<string, unknown>;
      const rawApplication = typeof value.application === "string" ? value.application.trim() : "";
      if (!rawApplication || rawApplication.length > 120) continue;
      const at = Math.floor(nonNegativeInteger(value.at) / 60_000) * 60_000;
      if (!at) continue;
      const application = applicationNames[rawApplication] || rawApplication;
      const receivedBytes = nonNegativeInteger(value.receivedBytes);
      const sentBytes = nonNegativeInteger(value.sentBytes);
      const requestCount = nonNegativeInteger(value.requestCount);
      const errorCount = nonNegativeInteger(value.errorCount);
      const day = singaporeDate(at);

      database.query(`
        INSERT INTO application_traffic_samples (at, application, received_bytes, sent_bytes, request_count, error_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(at, application) DO UPDATE SET
          received_bytes = received_bytes + excluded.received_bytes,
          sent_bytes = sent_bytes + excluded.sent_bytes,
          request_count = request_count + excluded.request_count,
          error_count = error_count + excluded.error_count
      `).run(at, application, receivedBytes, sentBytes, requestCount, errorCount);
      database.query(`
        INSERT INTO application_traffic_daily (day, application, received_bytes, sent_bytes, request_count, error_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, application) DO UPDATE SET
          received_bytes = received_bytes + excluded.received_bytes,
          sent_bytes = sent_bytes + excluded.sent_bytes,
          request_count = request_count + excluded.request_count,
          error_count = error_count + excluded.error_count
      `).run(day, application, receivedBytes, sentBytes, requestCount, errorCount);
      accepted += 1;
    }
    return Response.json({ accepted }, { status: 202 });
  } catch {
    return Response.json({ error: "invalid JSON payload" }, { status: 400 });
  }
}

function applicationTrafficHistory(application?: string) {
  const now = Date.now();
  const since = singaporeDate(now - 29 * 24 * 60 * 60 * 1000);
  const parameters = application ? [since, application] : [since];
  const filter = application ? "AND application = ?" : "";
  const daily = database.query(`
    SELECT day, application,
      received_bytes AS receivedBytes,
      sent_bytes AS sentBytes,
      request_count AS requestCount,
      error_count AS errorCount
    FROM application_traffic_daily
    WHERE day >= ? ${filter}
    ORDER BY day DESC, application ASC
  `).all(...parameters) as Array<{ day: string; application: string; receivedBytes: number; sentBytes: number; requestCount: number; errorCount: number }>;
  const applications = database.query(`
    SELECT application,
      SUM(received_bytes) AS receivedBytes,
      SUM(sent_bytes) AS sentBytes,
      SUM(request_count) AS requestCount,
      SUM(error_count) AS errorCount
    FROM application_traffic_daily
    WHERE day >= ?
    GROUP BY application
    ORDER BY receivedBytes + sentBytes DESC, application ASC
  `).all(since) as Array<{ application: string; receivedBytes: number; sentBytes: number; requestCount: number; errorCount: number }>;
  const live = application ? snapshot() : undefined;
  return {
    updatedAt: new Date().toISOString(),
    application: application || null,
    applications,
    daily,
    processes: application ? live?.processes.filter((process) => process.application === application) : [],
    connections: application ? live?.connections.filter((connection) => connection.application === application) : [],
    detailedRetentionDays: 30,
    dailyRetentionDays: 365
  };
}

function readNetwork() {
  const totals = readNetworkTotals();
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

recordBandwidth();
setInterval(recordBandwidth, 60_000);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `${basePath}/favicon.svg`) {
      return frontendResponse("favicon.svg", "image/svg+xml", "public, max-age=86400");
    }
    if (url.pathname === `${basePath}/api/snapshot`) {
      return Response.json(snapshot(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === `${basePath}/api/history`) {
      return Response.json(bandwidthHistory(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === `${basePath}/api/application-traffic` && request.method === "POST") {
      return ingestApplicationTraffic(request);
    }
    if (url.pathname === `${basePath}/api/application-history`) {
      const application = url.searchParams.get("application")?.trim() || undefined;
      return Response.json(applicationTrafficHistory(application), { headers: { "cache-control": "no-store" } });
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
