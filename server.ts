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

const applicationNames: Record<string, string> = {
  "aurelia-gt-preview": "Aurelia GT Preview",
  "openclaw-dashboard": "OpenClaw",
  "orin-discuss-reset-bridge": "Orin: Discuss Reset",
  "orin-prompt-alchemist-reset-bridge": "Orin: Prompt Alchemist Reset",
  "orin-skill-approval-bridge": "Orin Skill Approval",
  "orin-whatsapp-watchdog": "Orin WhatsApp Watchdog",
  "private-apps": "Private Apps Router",
  "public-apps": "Public Apps Router",
  tailscale: "Tailscale",
  "zo-backlog": "Zo Backlog",
  "zo-drive": "Zo Drive",
  "zo-expert": "Zo Expert",
  "zo-memories": "Zo Moments",
  "zo-moments": "Zo Moments",
  "zo-pocketbase": "Zo PocketBase",
  "zo-relationship-mapper": "Zo Relationship Mapper",
  "zo-router": "Zo Router",
  "zo-tube": "ZoTube",
  "zo-usage": "Usage Dashboard",
  "zominai-runtime": "ZoMinAI Runtime",
  zotube: "ZoTube"
};

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

function favicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#122b22"/><path d="M13 39h9l5-17 8 26 5-14h11" fill="none" stroke="#dff46f" stroke-linecap="round" stroke-linejoin="round" stroke-width="5"/><circle cx="51" cy="34" r="3" fill="#ffffff"/></svg>`;
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Usage</title>
  <link rel="icon" type="image/svg+xml" href="${basePath}/favicon.svg" />
  <style>
    :root { --ink:#11221c; --muted:#64736c; --line:#d6dfd8; --paper:#f6f6f1; --card:#ffffff; --lime:#dff46f; --deep:#122b22; --amber:#efaa3d; --red:#dc5a40; }
    * { box-sizing:border-box; } html,body { height:100%; overflow:hidden; } body { margin:0; background:radial-gradient(circle at 94% 2%,#e0efbd 0,transparent 27rem),var(--paper); color:var(--ink); font-family:"IBM Plex Mono","SFMono-Regular",Consolas,monospace; letter-spacing:-.025em; }
    main { max-width:1440px; height:100dvh; margin:0 auto; padding:22px 28px 18px; display:flex; flex-direction:column; } header { display:flex; align-items:end; justify-content:space-between; gap:20px; padding:8px 0 22px; border-bottom:1px solid var(--line); flex:0 0 auto; }
    h1 { font-family:Georgia,serif; font-size:clamp(2.7rem,7vw,5.4rem); font-weight:500; letter-spacing:-.075em; margin:0; line-height:.88; } .eyebrow,.label { color:var(--muted); text-transform:uppercase; font-size:11px; font-weight:700; letter-spacing:.1em; }
    .fresh { color:#2d7052; font-size:12px; text-align:right; } .fresh b { display:inline-block; width:8px; height:8px; border-radius:50%; background:#4ea778; margin-right:6px; }
    .summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:20px 0 14px; flex:0 0 auto; } .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; box-shadow:0 2px 0 rgba(17,34,28,.03); min-width:0; }
    .stat { font-family:Georgia,serif; font-size:clamp(2rem,4vw,3.65rem); letter-spacing:-.07em; line-height:1; margin:12px 0 7px; white-space:nowrap; } .detail { color:var(--muted); font-size:12px; line-height:1.45; }
    .meter { height:7px; border-radius:20px; background:#e7ece6; overflow:hidden; margin-top:15px; } .meter > i { display:block; height:100%; background:var(--deep); border-radius:20px; transition:width .5s ease; }
    .workspace { margin-top:14px; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; } .tabs { display:flex; gap:8px; border-bottom:1px solid var(--line); padding:0 2px; flex:0 0 auto; } .tab { appearance:none; background:transparent; border:0; border-bottom:3px solid transparent; color:var(--muted); cursor:pointer; font:700 12px/1 "IBM Plex Mono","SFMono-Regular",Consolas,monospace; letter-spacing:.08em; padding:14px 16px 12px; text-transform:uppercase; } .tab:hover { color:var(--ink); } .tab[aria-selected="true"] { border-bottom-color:var(--deep); color:var(--ink); }
    .process-card { border-top-left-radius:0; border-top-right-radius:0; padding:24px 28px 0; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; } .section-title { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin:0 0 8px; flex:0 0 auto; } h2 { font-family:Georgia,serif; font-weight:500; letter-spacing:-.045em; margin:0; font-size:2rem; } .note { color:var(--muted); font-size:11px; } .consumer-note { color:var(--muted); font-size:13px; line-height:1.5; margin:0 0 16px; flex:0 0 auto; }
    .activity-accounting { display:grid; grid-template-columns:190px minmax(0,1fr); height:64px; gap:0; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:0 0 8px; flex:0 0 auto; } .pressure-panel { background:#f1f5ec; padding:8px 12px; } .pressure-title { color:var(--muted); font-size:9px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; } .pressure-state { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin:3px 0 5px; } .pressure-state strong { font-family:Georgia,serif; font-size:1.15rem; font-weight:500; letter-spacing:-.04em; } .pressure-detail { color:var(--muted); font-size:9px; } .pressure-track { height:6px; background:#dbe4d9; border-radius:99px; overflow:hidden; } .pressure-track i { display:block; height:100%; width:0; background:#4ea778; border-radius:inherit; transition:width .5s ease,background .5s ease; } .accounting-grid { display:grid; grid-template-columns:repeat(8,minmax(104px,1fr)); margin:0; overflow-x:auto; scrollbar-width:none; } .accounting-grid::-webkit-scrollbar { display:none; } .accounting-item { border-left:1px solid var(--line); padding:8px 10px; min-width:0; } .accounting-item dt { color:var(--muted); font-size:8px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .accounting-item dd { font-family:Georgia,serif; font-size:1.05rem; letter-spacing:-.045em; margin:4px 0 0; white-space:nowrap; } #memory-panel.process-card,#disk-panel.process-card,#network-panel.process-card { padding-top:16px; } #memory-panel .consumer-note,#disk-panel .consumer-note,#network-panel .consumer-note { margin-bottom:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .panel[hidden] { display:none; } .table-scroll { flex:1 1 auto; min-height:0; overflow:auto; scrollbar-color:#9caea3 transparent; } table { width:100%; border-collapse:collapse; font-size:13px; } th { position:sticky; top:0; z-index:1; background:var(--card); color:var(--muted); text-align:right; font-weight:600; font-size:10px; letter-spacing:.08em; text-transform:uppercase; padding:0 0 10px; } th:first-child { width:92px; text-align:left; } th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3) { text-align:left; } th:nth-child(2) { width:31%; } th:nth-child(3) { width:25%; } td { border-top:1px solid #e8ede8; padding:10px 0; text-align:right; } .pid { color:var(--muted); padding-right:22px; text-align:left; white-space:nowrap; } .application { min-width:180px; } .application strong,.application span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .application strong { font-weight:700; } .application span { color:var(--muted); font-size:10px; margin-top:3px; } .process { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:0; padding-right:16px; }
    body.detail-active main { padding-top:14px; padding-bottom:12px; } body.detail-active header { padding:2px 0 13px; } body.detail-active h1 { font-size:clamp(2.5rem,5vw,3.7rem); } body.detail-active .summary { margin:12px 0 8px; } body.detail-active .summary .card { padding:12px 18px; } body.detail-active .summary .stat { font-size:2.55rem; margin:8px 0 5px; } body.detail-active .summary .meter { margin-top:10px; }
    @media (max-width:900px) { .summary { grid-template-columns:repeat(2,minmax(0,1fr)); } } @media (max-width:560px) { main { padding:16px 15px 14px; } header { align-items:start; flex-direction:column; padding-bottom:16px; } .fresh { text-align:left; } .summary { gap:8px; margin:14px 0 8px; } .card { padding:14px; } .stat { font-size:2rem; } .process-card { padding:18px 14px 0; } .tab { padding-inline:12px; } .activity-accounting { grid-template-columns:160px minmax(0,1fr); } .table-scroll { overflow:auto; } table { min-width:820px; } }
  </style>
</head>
<body><main>
  <header><div><div class="eyebrow">Zo host observability</div><h1>Usage</h1></div><div class="fresh"><b></b>Live data<br><span id="updated">Connecting...</span></div></header>
  <section class="summary">
    <article class="card"><div class="label">CPU now</div><div class="stat" id="cpu">--</div><div class="detail" id="cpu-detail">Across all cores</div><div class="meter"><i id="cpu-meter"></i></div></article>
    <article class="card"><div class="label">Memory in use</div><div class="stat" id="memory">--</div><div class="detail" id="memory-detail">Reading host memory</div><div class="meter"><i id="memory-meter"></i></div></article>
    <article class="card"><div class="label">Storage used</div><div class="stat" id="disk">--</div><div class="detail" id="disk-detail">Reading root volume</div><div class="meter"><i id="disk-meter"></i></div></article>
    <article class="card"><div class="label">Network traffic</div><div class="stat" id="network">--</div><div class="detail" id="network-detail">Measuring current rate</div><div class="meter"><i id="network-meter" style="width:0"></i></div></article>
  </section>
  <section class="workspace" aria-label="Resource task manager">
    <div class="tabs" role="tablist" aria-label="Resource views">
      <button class="tab" id="cpu-tab" role="tab" aria-selected="true" aria-controls="cpu-panel">CPU</button>
      <button class="tab" id="memory-tab" role="tab" aria-selected="false" aria-controls="memory-panel">Memory</button>
      <button class="tab" id="disk-tab" role="tab" aria-selected="false" aria-controls="disk-panel">Disk</button>
      <button class="tab" id="network-tab" role="tab" aria-selected="false" aria-controls="network-panel">Network</button>
    </div>
    <article class="card process-card panel" id="cpu-panel" role="tabpanel" aria-labelledby="cpu-tab"><div class="section-title"><h2>CPU processes</h2><span class="note">sorted by CPU use</span></div><p class="consumer-note" id="cpu-explanation">Loading process data...</p><div class="table-scroll"><table><thead><tr><th>PID</th><th>Application</th><th>Runtime process</th><th>CPU</th><th>Memory</th><th>Disk I/O</th></tr></thead><tbody id="cpu-processes"></tbody></table></div></article>
    <article class="card process-card panel" id="memory-panel" role="tabpanel" aria-labelledby="memory-tab" hidden><div class="section-title"><h2>Memory processes</h2><span class="note">sorted by resident memory</span></div><p class="consumer-note" id="memory-explanation">Loading process data...</p><section class="activity-accounting" aria-label="Memory breakdown"><div class="pressure-panel"><div class="pressure-title">Memory pressure</div><div class="pressure-state"><strong id="memory-pressure">Reading...</strong><span class="pressure-detail" id="memory-pressure-detail"></span></div><div class="pressure-track"><i id="memory-pressure-meter"></i></div></div><dl class="accounting-grid"><div class="accounting-item"><dt>Physical RAM</dt><dd id="physical-memory">--</dd></div><div class="accounting-item"><dt>Memory used</dt><dd id="used-memory">--</dd></div><div class="accounting-item"><dt>Available</dt><dd id="available-memory">--</dd></div><div class="accounting-item"><dt>Process resident*</dt><dd id="process-resident">--</dd></div><div class="accounting-item"><dt>File cache</dt><dd id="file-cache">--</dd></div><div class="accounting-item"><dt>Kernel memory</dt><dd id="kernel-memory">--</dd></div><div class="accounting-item"><dt>Shared memory</dt><dd id="shared-memory">--</dd></div><div class="accounting-item"><dt>Swap used</dt><dd id="swap-used">--</dd></div></dl></section><div class="table-scroll"><table><thead><tr><th>PID</th><th>Application</th><th>Runtime process</th><th>Resident</th><th>Threads</th><th>CPU</th><th>Disk I/O</th></tr></thead><tbody id="memory-processes"></tbody></table></div></article>
    <article class="card process-card panel" id="disk-panel" role="tabpanel" aria-labelledby="disk-tab" hidden><div class="section-title"><h2>Disk activity</h2><span class="note">sorted by live I/O</span></div><p class="consumer-note" id="disk-explanation">Loading process data...</p><section class="activity-accounting" aria-label="Disk activity breakdown"><div class="pressure-panel"><div class="pressure-title">Volume capacity</div><div class="pressure-state"><strong id="disk-capacity">Reading...</strong><span class="pressure-detail" id="disk-capacity-detail"></span></div><div class="pressure-track"><i id="disk-capacity-meter"></i></div></div><dl class="accounting-grid"><div class="accounting-item"><dt>Volume size</dt><dd id="disk-total">--</dd></div><div class="accounting-item"><dt>Used</dt><dd id="disk-used">--</dd></div><div class="accounting-item"><dt>Available</dt><dd id="disk-available">--</dd></div><div class="accounting-item"><dt>Read rate</dt><dd id="disk-read-rate">--</dd></div><div class="accounting-item"><dt>Write rate</dt><dd id="disk-write-rate">--</dd></div><div class="accounting-item"><dt>Active reads*</dt><dd id="disk-tracked-read">--</dd></div><div class="accounting-item"><dt>Active writes*</dt><dd id="disk-tracked-write">--</dd></div><div class="accounting-item"><dt>Tracked apps</dt><dd id="disk-app-count">--</dd></div></dl></section><div class="table-scroll"><table><thead><tr><th>PID</th><th>Application</th><th>Runtime process</th><th>Read/s</th><th>Write/s</th><th>Total read</th><th>Total written</th></tr></thead><tbody id="disk-processes"></tbody></table></div></article>
    <article class="card process-card panel" id="network-panel" role="tabpanel" aria-labelledby="network-tab" hidden><div class="section-title"><h2>Network connections</h2><span class="note">active sockets by application</span></div><p class="consumer-note" id="network-explanation">Loading connection data...</p><section class="activity-accounting" aria-label="Network activity breakdown"><div class="pressure-panel"><div class="pressure-title">Network traffic</div><div class="pressure-state"><strong id="network-state">Reading...</strong><span class="pressure-detail" id="network-state-detail"></span></div><div class="pressure-track"><i id="network-meter"></i></div></div><dl class="accounting-grid"><div class="accounting-item"><dt>Received / sec</dt><dd id="network-down-rate">--</dd></div><div class="accounting-item"><dt>Sent / sec</dt><dd id="network-up-rate">--</dd></div><div class="accounting-item"><dt>Packets in / sec</dt><dd id="network-down-packets">--</dd></div><div class="accounting-item"><dt>Packets out / sec</dt><dd id="network-up-packets">--</dd></div><div class="accounting-item"><dt>Data received</dt><dd id="network-received">--</dd></div><div class="accounting-item"><dt>Data sent</dt><dd id="network-sent">--</dd></div><div class="accounting-item"><dt>Open sockets</dt><dd id="network-sockets">--</dd></div><div class="accounting-item"><dt>Listening</dt><dd id="network-listening">--</dd></div></dl></section><div class="table-scroll"><table><thead><tr><th>PID</th><th>Application</th><th>Runtime process</th><th>Protocol</th><th>State</th><th>Local address</th><th>Remote address</th></tr></thead><tbody id="network-connections"></tbody></table></div></article>
  </section>
</main><script>
const base = ${JSON.stringify(basePath)};
const bytes = value => { const units=['B','KB','MB','GB','TB']; let i=0; while(value>=1024&&i<units.length-1){value/=1024;i++} return (value>=10||i===0?value.toFixed(0):value.toFixed(1))+' '+units[i] };
const percent = value => value.toFixed(value < 10 ? 1 : 0)+'%';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function rows(processes,mode){ return processes.slice().sort((a,b)=>mode==='cpu'?b.cpu-a.cpu:b.memory-a.memory).slice(0,15).map(p=>'<tr><td class="pid">'+p.pid+'</td><td class="application" title="'+escape(p.application)+'"><strong>'+escape(p.application)+'</strong><span>'+escape(p.role)+'</span></td><td class="process" title="'+escape(p.name)+'">'+escape(p.name)+'</td><td>'+(mode==='cpu'?percent(p.cpu):bytes(p.memory))+'</td><td>'+(mode==='cpu'?bytes(p.memory):percent(p.cpu))+'</td><td>'+bytes(p.disk)+'/s</td></tr>').join('') }
function memoryRows(processes){ return processes.slice().sort((a,b)=>b.memory-a.memory).slice(0,20).map(p=>'<tr><td class="pid">'+p.pid+'</td><td class="application" title="'+escape(p.application)+'"><strong>'+escape(p.application)+'</strong><span>'+escape(p.role)+'</span></td><td class="process" title="'+escape(p.name)+'">'+escape(p.name)+'</td><td>'+bytes(p.memory)+'</td><td>'+p.threads+'</td><td>'+percent(p.cpu)+'</td><td>'+bytes(p.disk)+'/s</td></tr>').join('') }
function diskRows(processes){ return processes.slice().sort((a,b)=>b.disk-a.disk).slice(0,20).map(p=>'<tr><td class="pid">'+p.pid+'</td><td class="application" title="'+escape(p.application)+'"><strong>'+escape(p.application)+'</strong><span>'+escape(p.role)+'</span></td><td class="process" title="'+escape(p.name)+'">'+escape(p.name)+'</td><td>'+bytes(p.diskReadRate)+'/s</td><td>'+bytes(p.diskWriteRate)+'/s</td><td>'+bytes(p.diskRead)+'</td><td>'+bytes(p.diskWrite)+'</td></tr>').join('') }
function connectionRows(connections){ return connections.slice(0,30).map(c=>'<tr><td class="pid">'+c.pid+'</td><td class="application" title="'+escape(c.application)+'"><strong>'+escape(c.application)+'</strong><span>'+escape(c.role)+'</span></td><td class="process" title="'+escape(c.name)+'">'+escape(c.name)+'</td><td>'+escape(c.protocol)+'</td><td>'+escape(c.state)+'</td><td>'+escape(c.local)+'</td><td>'+escape(c.remote)+'</td></tr>').join('') }
function leadingApplication(processes,metric){ const totals=new Map(); for(const process of processes){ const current=totals.get(process.application)||{application:process.application,cpu:0,memory:0,count:0}; current.cpu+=process.cpu; current.memory+=process.memory; current.count++; totals.set(process.application,current); } return [...totals.values()].sort((a,b)=>b[metric]-a[metric])[0] }
function setTab(name){ const tabs=['cpu','memory','disk','network']; document.body.classList.toggle('detail-active',name!=='cpu'); for(const tab of tabs){ const selected=tab===name; document.querySelector('#'+tab+'-tab').setAttribute('aria-selected',String(selected)); document.querySelector('#'+tab+'-panel').hidden=!selected; } }
document.querySelector('#cpu-tab').addEventListener('click',()=>setTab('cpu')); document.querySelector('#memory-tab').addEventListener('click',()=>setTab('memory')); document.querySelector('#disk-tab').addEventListener('click',()=>setTab('disk')); document.querySelector('#network-tab').addEventListener('click',()=>setTab('network'));
function renderDetails(data){ const diskPct=data.disk.used/data.disk.total*100, activeApps=new Set(data.processes.filter(p=>p.diskRead||p.diskWrite).map(p=>p.application)).size, listening=data.connections.filter(c=>c.state==='LISTEN').length; document.querySelector('#disk-processes').innerHTML=diskRows(data.processes); document.querySelector('#disk-capacity').textContent=percent(diskPct)+' used'; document.querySelector('#disk-capacity-detail').textContent=bytes(data.disk.available)+' free'; document.querySelector('#disk-capacity-meter').style.width=diskPct+'%'; document.querySelector('#disk-total').textContent=bytes(data.disk.total); document.querySelector('#disk-used').textContent=bytes(data.disk.used); document.querySelector('#disk-available').textContent=bytes(data.disk.available); document.querySelector('#disk-read-rate').textContent=bytes(data.disk.readRate)+'/s'; document.querySelector('#disk-write-rate').textContent=bytes(data.disk.writeRate)+'/s'; document.querySelector('#disk-tracked-read').textContent=bytes(data.disk.trackedRead); document.querySelector('#disk-tracked-write').textContent=bytes(data.disk.trackedWrite); document.querySelector('#disk-app-count').textContent=activeApps; const diskLeader=data.processes.slice().sort((a,b)=>b.disk-a.disk)[0]; document.querySelector('#disk-explanation').textContent=diskLeader&&diskLeader.disk>0?diskLeader.application+' ('+diskLeader.name+') is currently generating the most I/O at '+bytes(diskLeader.disk)+'/s. Total read/write values cover active processes.':'No active process disk I/O right now. Totals cover active processes; host device counters are not exposed in this Zo container.'; document.querySelector('#network-connections').innerHTML=connectionRows(data.connections); document.querySelector('#network-state').textContent=bytes(data.network.down)+'/s down'; document.querySelector('#network-state-detail').textContent=bytes(data.network.up)+'/s up'; document.querySelector('#network-panel .pressure-track i').style.width=Math.min(100,(data.network.down+data.network.up)/1024/1024*100)+'%'; document.querySelector('#network-down-rate').textContent=bytes(data.network.down)+'/s'; document.querySelector('#network-up-rate').textContent=bytes(data.network.up)+'/s'; document.querySelector('#network-down-packets').textContent=Math.round(data.network.downPackets)+'/s'; document.querySelector('#network-up-packets').textContent=Math.round(data.network.upPackets)+'/s'; document.querySelector('#network-received').textContent=bytes(data.network.received); document.querySelector('#network-sent').textContent=bytes(data.network.sent); document.querySelector('#network-sockets').textContent=data.connections.length; document.querySelector('#network-listening').textContent=listening; document.querySelector('#network-explanation').textContent=data.connections.length+' active sockets are attributed to their owning application. Network byte totals are interface-wide; Linux does not expose per-process socket byte counters here.'; }
function render(data){ const memoryPct=data.memory.used/data.memory.total*100, diskPct=data.disk.used/data.disk.total*100, availablePct=data.memory.available/data.memory.total*100; const pressure=availablePct>25?{label:'Low',color:'#4ea778'}:availablePct>10?{label:'Moderate',color:'#efaa3d'}:{label:'High',color:'#dc5a40'}; document.querySelector('#cpu').textContent=percent(data.cpu); document.querySelector('#cpu-detail').textContent='across '+data.cores+' allocated cores'; document.querySelector('#cpu-meter').style.width=data.cpu+'%'; document.querySelector('#memory').textContent=bytes(data.memory.used); document.querySelector('#memory-detail').textContent='of '+bytes(data.memory.total)+' · '+percent(memoryPct); document.querySelector('#memory-meter').style.width=memoryPct+'%'; document.querySelector('#disk').textContent=bytes(data.disk.used); document.querySelector('#disk-detail').textContent='of '+bytes(data.disk.total)+' · '+percent(diskPct); document.querySelector('#disk-meter').style.width=diskPct+'%'; document.querySelector('#network').textContent=bytes(data.network.down)+'/s'; document.querySelector('#network-detail').textContent='down · '+bytes(data.network.up)+' up'; document.querySelector('#cpu-processes').innerHTML=rows(data.processes,'cpu'); document.querySelector('#memory-processes').innerHTML=memoryRows(data.processes); document.querySelector('#updated').textContent='Updated '+new Date(data.updatedAt).toLocaleTimeString(); document.querySelector('#memory-pressure').textContent=pressure.label; document.querySelector('#memory-pressure-detail').textContent=percent(availablePct)+' available'; document.querySelector('#memory-pressure-meter').style.width=memoryPct+'%'; document.querySelector('#memory-pressure-meter').style.background=pressure.color; document.querySelector('#physical-memory').textContent=bytes(data.memory.total); document.querySelector('#used-memory').textContent=bytes(data.memory.used); document.querySelector('#available-memory').textContent=bytes(data.memory.available); document.querySelector('#process-resident').textContent=bytes(data.memory.processResident); document.querySelector('#file-cache').textContent=bytes(data.memory.fileCache); document.querySelector('#kernel-memory').textContent=data.memory.kernelKnown?bytes(data.memory.kernel):'N/A'; document.querySelector('#shared-memory').textContent=bytes(data.memory.shared); document.querySelector('#swap-used').textContent=bytes(data.memory.swapUsed); const cpu=leadingApplication(data.processes,'cpu'), mem=leadingApplication(data.processes,'memory'); document.querySelector('#cpu-explanation').textContent=cpu ? cpu.application+' is currently using the most CPU at '+percent(cpu.cpu)+' across '+cpu.count+' process'+(cpu.count===1?'':'es')+'.' : 'No process data available.'; document.querySelector('#memory-explanation').textContent=mem ? mem.application+' is using the most resident memory at '+bytes(mem.memory)+' across '+mem.count+' process'+(mem.count===1?'':'es')+'. Resident memory totals can include shared pages, so use them to compare processes rather than add them to Memory Used.' : 'No process data available.'; }
async function refresh(){ try { const response=await fetch(base+'/api/snapshot',{cache:'no-store'}); if(!response.ok)throw new Error(); const data=await response.json(); render(data); renderDetails(data) } catch { document.querySelector('#updated').textContent='Unable to read host metrics'; } }
refresh(); setInterval(refresh,5000);
</script></body></html>`;
}

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `${basePath}/favicon.svg`) {
      return new Response(favicon(), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    }
    if (url.pathname === `${basePath}/api/snapshot`) {
      return Response.json(snapshot(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === basePath || url.pathname === `${basePath}/`) {
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  }
});
