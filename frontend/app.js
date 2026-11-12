const base = "__APP_BASE_PATH__";
const bytes = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return (
    (value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)) +
    " " +
    units[i]
  );
};
const rate = (value) => value === null || value === undefined ? "N/A" : bytes(value) + "/s";
const percent = (value) => value.toFixed(value < 10 ? 1 : 0) + "%";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
function rows(processes, mode) {
  return processes
    .slice()
    .sort((a, b) => (mode === "cpu" ? b.cpu - a.cpu : b.memory - a.memory))
    .slice(0, 15)
    .map(
      (p) =>
        '<tr><td class="pid">' +
        p.pid +
        '</td><td class="application" title="' +
        escape(p.application) +
        '"><strong>' +
        escape(p.application) +
        "</strong><span>" +
        escape(p.role) +
        '</span></td><td class="process" title="' +
        escape(p.name) +
        '">' +
        escape(p.name) +
        "</td><td>" +
        (mode === "cpu" ? percent(p.cpu) : bytes(p.memory)) +
        "</td><td>" +
        (mode === "cpu" ? bytes(p.memory) : percent(p.cpu)) +
        "</td><td>" +
        rate(p.disk) +
        "</td></tr>",
    )
    .join("");
}
function memoryRows(processes) {
  return processes
    .slice()
    .sort((a, b) => b.memory - a.memory)
    .slice(0, 20)
    .map(
      (p) =>
        '<tr><td class="pid">' +
        p.pid +
        '</td><td class="application" title="' +
        escape(p.application) +
        '"><strong>' +
        escape(p.application) +
        "</strong><span>" +
        escape(p.role) +
        '</span></td><td class="process" title="' +
        escape(p.name) +
        '">' +
        escape(p.name) +
        "</td><td>" +
        bytes(p.memory) +
        "</td><td>" +
        p.threads +
        "</td><td>" +
        percent(p.cpu) +
        "</td><td>" +
        rate(p.disk) +
        "</td></tr>",
    )
    .join("");
}
function diskRows(processes) {
  return processes
    .slice()
    .sort((a, b) => b.disk - a.disk)
    .slice(0, 20)
    .map(
      (p) =>
        '<tr><td class="pid">' +
        p.pid +
        '</td><td class="application" title="' +
        escape(p.application) +
        '"><strong>' +
        escape(p.application) +
        "</strong><span>" +
        escape(p.role) +
        '</span></td><td class="process" title="' +
        escape(p.name) +
        '">' +
        escape(p.name) +
        "</td><td>" +
        rate(p.diskReadRate) +
        "</td><td>" +
        rate(p.diskWriteRate) +
        "</td><td>" +
        bytes(p.diskRead) +
        "</td><td>" +
        bytes(p.diskWrite) +
        "</td></tr>",
    )
    .join("");
}
function connectionRows(connections) {
  return connections
    .slice(0, 30)
    .map(
      (c) =>
        '<tr><td class="pid">' +
        c.pid +
        '</td><td class="application" title="' +
        escape(c.application) +
        '"><strong>' +
        escape(c.application) +
        "</strong><span>" +
        escape(c.role) +
        '</span></td><td class="process" title="' +
        escape(c.name) +
        '">' +
        escape(c.name) +
        "</td><td>" +
        escape(c.protocol) +
        "</td><td>" +
        escape(c.state) +
        "</td><td>" +
        escape(c.local) +
        "</td><td>" +
        escape(c.remote) +
        "</td></tr>",
    )
    .join("");
}
function historyRows(days) {
  return (
    days
      .map(
        (day) =>
          '<tr><td class="history-date">' +
          escape(day.day) +
          "</td><td>" +
          bytes(day.receivedBytes) +
          "</td><td>" +
          bytes(day.sentBytes) +
          "</td><td>" +
          bytes(day.receivedBytes + day.sentBytes) +
          "</td><td>" +
          day.receivedPackets.toLocaleString() +
          "</td><td>" +
          day.sentPackets.toLocaleString() +
          "</td></tr>",
      )
      .join("") ||
    '<tr><td colspan="6" class="empty-row">Collecting the first minute of bandwidth history...</td></tr>'
  );
}
function trafficTotals(rows) {
  return rows.reduce(
    (sum, row) => ({
      receivedBytes: sum.receivedBytes + row.receivedBytes,
      sentBytes: sum.sentBytes + row.sentBytes,
      requestCount: sum.requestCount + row.requestCount,
      errorCount: sum.errorCount + row.errorCount,
    }),
    { receivedBytes: 0, sentBytes: 0, requestCount: 0, errorCount: 0 },
  );
}
function applicationRows(applications) {
  return (
    applications
      .map(
        (app) =>
          '<tr><td class="application"><button class="app-drill" data-application="' +
          escape(app.application) +
          '" title="Open ' +
          escape(app.application) +
          ' details"><strong>' +
          escape(app.application) +
          "</strong><span>View activity</span></button></td><td>" +
          bytes(app.receivedBytes) +
          "</td><td>" +
          bytes(app.sentBytes) +
          "</td><td>" +
          bytes(app.receivedBytes + app.sentBytes) +
          "</td><td>" +
          app.requestCount.toLocaleString() +
          "</td><td>" +
          app.errorCount.toLocaleString() +
          "</td></tr>",
      )
      .join("") ||
    '<tr><td colspan="6" class="empty-row">Traffic will appear after the routers complete their first minute.</td></tr>'
  );
}
function applicationDailyRows(days) {
  return (
    days
      .map(
        (day) =>
          '<tr><td class="history-date">' +
          escape(day.day) +
          "</td><td>" +
          bytes(day.receivedBytes) +
          "</td><td>" +
          bytes(day.sentBytes) +
          "</td><td>" +
          bytes(day.receivedBytes + day.sentBytes) +
          "</td><td>" +
          day.requestCount.toLocaleString() +
          "</td><td>" +
          day.errorCount.toLocaleString() +
          "</td></tr>",
      )
      .join("") ||
    '<tr><td colspan="6" class="empty-row">No routed traffic recorded yet.</td></tr>'
  );
}
function leadingApplication(processes, metric) {
  const totals = new Map();
  for (const process of processes) {
    const current = totals.get(process.application) || {
      application: process.application,
      cpu: 0,
      memory: 0,
      count: 0,
    };
    current.cpu += process.cpu;
    current.memory += process.memory;
    current.count++;
    totals.set(process.application, current);
  }
  return [...totals.values()].sort((a, b) => b[metric] - a[metric])[0];
}
const overview = document.querySelector("#host-overview");
const overviewToggle = document.querySelector("#overview-toggle");
const overviewPreferenceKey = "zo-usage.overview-hidden";
function setOverviewHidden(hidden) {
  overview.hidden = hidden;
  document.body.classList.toggle("overview-hidden", hidden);
  overviewToggle.setAttribute("aria-expanded", String(!hidden));
  overviewToggle.textContent = hidden ? "Show overview" : "Hide overview";
}
try {
  setOverviewHidden(localStorage.getItem(overviewPreferenceKey) === "true");
} catch {
  setOverviewHidden(false);
}
overviewToggle.addEventListener("click", () => {
  setOverviewHidden(!overview.hidden);
  try {
    localStorage.setItem(overviewPreferenceKey, String(overview.hidden));
  } catch {}
});
let activeTab = "cpu",
  selectedApplication = "";
function setTab(name) {
  const tabs = [
    "cpu",
    "memory",
    "disk",
    "storage",
    "network",
    "applications",
    "history",
  ];
  activeTab = name;
  document.body.classList.toggle("detail-active", name !== "cpu");
  document.body.classList.toggle("storage-active", name === "storage");
  for (const tab of tabs) {
    const selected = tab === name;
    document
      .querySelector("#" + tab + "-tab")
      .setAttribute("aria-selected", String(selected));
    document.querySelector("#" + tab + "-panel").hidden = !selected;
  }
  if (name === "history") refreshHistory();
  if (name === "applications") refreshApplications();
  if (name === "storage") refreshStorage();
}
document
  .querySelector("#cpu-tab")
  .addEventListener("click", () => setTab("cpu"));
document
  .querySelector("#memory-tab")
  .addEventListener("click", () => setTab("memory"));
document
  .querySelector("#disk-tab")
  .addEventListener("click", () => setTab("disk"));
document
  .querySelector("#storage-tab")
  .addEventListener("click", () => setTab("storage"));
document
  .querySelector("#network-tab")
  .addEventListener("click", () => setTab("network"));
document
  .querySelector("#applications-tab")
  .addEventListener("click", () => setTab("applications"));
document
  .querySelector("#history-tab")
  .addEventListener("click", () => setTab("history"));
document
  .querySelector("#application-traffic")
  .addEventListener("click", (event) => {
    const button = event.target.closest(".app-drill");
    if (!button) return;
    selectedApplication = button.dataset.application || "";
    refreshApplications();
  });
document.querySelector("#application-back").addEventListener("click", () => {
  selectedApplication = "";
  refreshApplications();
});
function renderDetails(data) {
  const diskPct = (data.disk.used / data.disk.total) * 100,
    activeApps = new Set(
      data.processes
        .filter((p) => p.diskRead || p.diskWrite)
        .map((p) => p.application),
    ).size,
    listening = data.connections.filter((c) => c.state === "LISTEN").length;
  document.querySelector("#disk-processes").innerHTML = diskRows(
    data.processes,
  );
  document.querySelector("#disk-capacity").textContent = bytes(data.disk.inventoryBytes);
  document.querySelector("#disk-capacity-detail").textContent =
    data.disk.inventoryUpdatedAt
      ? "Scanned " + new Date(data.disk.inventoryUpdatedAt).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore" }) +
        (data.disk.inventoryStale ? " · Last scan" : "") + (data.disk.inventoryIncomplete ? " · Partial scan" : "")
      : "Scanning visible locations...";
  document.querySelector("#disk-capacity-meter").style.width = data.disk.volumeComparable ? diskPct + "%" : "0%";
  document.querySelector("#disk-total").textContent = bytes(data.disk.total);
  document.querySelector("#disk-used").textContent = bytes(data.disk.used);
  document.querySelector("#disk-available").textContent = data.disk.volumeComparable ? bytes(data.disk.available) : "N/A";
  document.querySelector("#disk-read-rate").textContent = rate(data.disk.readRate);
  document.querySelector("#disk-write-rate").textContent = rate(data.disk.writeRate);
  document.querySelector("#disk-tracked-read").textContent = bytes(
    data.disk.trackedRead,
  );
  document.querySelector("#disk-tracked-write").textContent = bytes(
    data.disk.trackedWrite,
  );
  document.querySelector("#disk-app-count").textContent = data.disk.ioSource === "unavailable" ? "N/A" : activeApps;
  document.querySelector("#io-heading").textContent = data.disk.ioSource === "physical" ? "Disk activity" : "Application I/O";
  document.querySelector("#io-source").textContent = data.disk.physicalIoAvailable ? "Physical disk counters" : "Physical disk I/O unavailable";
  document.querySelector("#disk-explanation").textContent = data.disk.ioDescription +
    " Lifetime totals cover currently running processes. Rates need two samples." +
    (!data.disk.volumeComparable ? " Volume figures below are virtual counters and cannot be used to calculate actual free space." : "");
  document.querySelector("#disk-explanation").title = document.querySelector("#disk-explanation").textContent;
  document.querySelector("#network-connections").innerHTML = connectionRows(
    data.connections,
  );
  document.querySelector("#network-state").textContent =
    bytes(data.network.down) + "/s down";
  document.querySelector("#network-state-detail").textContent =
    bytes(data.network.up) + "/s up";
  document.querySelector("#network-panel .pressure-track i").style.width =
    Math.min(100, ((data.network.down + data.network.up) / 1024 / 1024) * 100) +
    "%";
  document.querySelector("#network-down-rate").textContent =
    bytes(data.network.down) + "/s";
  document.querySelector("#network-up-rate").textContent =
    bytes(data.network.up) + "/s";
  document.querySelector("#network-down-packets").textContent =
    Math.round(data.network.downPackets) + "/s";
  document.querySelector("#network-up-packets").textContent =
    Math.round(data.network.upPackets) + "/s";
  document.querySelector("#network-received").textContent = bytes(
    data.network.received,
  );
  document.querySelector("#network-sent").textContent = bytes(
    data.network.sent,
  );
  document.querySelector("#network-sockets").textContent =
    data.connections.length;
  document.querySelector("#network-listening").textContent = listening;
  document.querySelector("#network-explanation").textContent =
    data.connections.length +
    " active sockets are attributed to their owning application. Network byte totals are interface-wide; Linux does not expose per-process socket byte counters here.";
}
function render(data) {
  const memoryPct = (data.memory.used / data.memory.total) * 100,
    diskPct = (data.disk.used / data.disk.total) * 100,
    availablePct = (data.memory.available / data.memory.total) * 100,
    cpuSamples = data.history.map((sample) => sample.cpu),
    cpuAverage =
      cpuSamples.reduce((sum, value) => sum + value, 0) /
      (cpuSamples.length || 1),
    cpuPeak = Math.max(...cpuSamples, 0);
  const pressure =
    availablePct > 25
      ? { label: "Low", color: "#4ea778" }
      : availablePct > 10
        ? { label: "Moderate", color: "#efaa3d" }
        : { label: "High", color: "#dc5a40" };
  document.querySelector("#cpu").textContent = percent(data.cpu);
  document.querySelector("#cpu-detail").textContent =
    "across " + data.cores + " allocated cores";
  document.querySelector("#cpu-meter").style.width = data.cpu + "%";
  document.querySelector("#cpu-capacity").textContent =
    percent(data.cpu) + " used";
  document.querySelector("#cpu-capacity-detail").textContent =
    data.cores + " cores allocated";
  document.querySelector("#cpu-capacity-meter").style.width = data.cpu + "%";
  document.querySelector("#cpu-cores").textContent = data.cores;
  document.querySelector("#cpu-load-one").textContent = data.load[0].toFixed(2);
  document.querySelector("#cpu-load-five").textContent =
    data.load[1].toFixed(2);
  document.querySelector("#cpu-load-fifteen").textContent =
    data.load[2].toFixed(2);
  document.querySelector("#cpu-average").textContent = percent(cpuAverage);
  document.querySelector("#cpu-peak").textContent = percent(cpuPeak);
  document.querySelector("#cpu-process-count").textContent =
    data.processes.length;
  document.querySelector("#memory").textContent = bytes(data.memory.used);
  document.querySelector("#memory-detail").textContent =
    "of " + bytes(data.memory.total) + " · " + percent(memoryPct);
  document.querySelector("#memory-meter").style.width = memoryPct + "%";
  document.querySelector("#disk").textContent = bytes(data.disk.inventoryBytes);
  document.querySelector("#disk-detail").textContent = data.disk.inventoryUpdatedAt
    ? "Visible locations · " + new Date(data.disk.inventoryUpdatedAt).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore" }) +
      (data.disk.inventoryStale ? " · Last scan" : "") + (data.disk.inventoryIncomplete ? " · Partial" : "")
    : "Scanning visible locations...";
  document.querySelector("#disk-meter").style.width = data.disk.volumeComparable ? diskPct + "%" : "0%";
  document.querySelector("#network").textContent =
    bytes(data.network.down) + "/s";
  document.querySelector("#network-detail").textContent =
    "down · " + bytes(data.network.up) + " up";
  document.querySelector("#cpu-processes").innerHTML = rows(
    data.processes,
    "cpu",
  );
  document.querySelector("#memory-processes").innerHTML = memoryRows(
    data.processes,
  );
  document.querySelector("#updated").textContent =
    "Updated " + new Date(data.updatedAt).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore" }) + " SGT";
  document.querySelector("#memory-pressure").textContent = pressure.label;
  document.querySelector("#memory-pressure-detail").textContent =
    percent(availablePct) + " available";
  document.querySelector("#memory-pressure-meter").style.width =
    memoryPct + "%";
  document.querySelector("#memory-pressure-meter").style.background =
    pressure.color;
  document.querySelector("#physical-memory").textContent = bytes(
    data.memory.total,
  );
  document.querySelector("#used-memory").textContent = bytes(data.memory.used);
  document.querySelector("#available-memory").textContent = bytes(
    data.memory.available,
  );
  document.querySelector("#process-resident").textContent = bytes(
    data.memory.processResident,
  );
  document.querySelector("#file-cache").textContent = bytes(
    data.memory.fileCache,
  );
  document.querySelector("#kernel-memory").textContent = data.memory.kernelKnown
    ? bytes(data.memory.kernel)
    : "N/A";
  document.querySelector("#shared-memory").textContent = bytes(
    data.memory.shared,
  );
  document.querySelector("#swap-used").textContent = bytes(
    data.memory.swapUsed,
  );
  const cpu = leadingApplication(data.processes, "cpu"),
    mem = leadingApplication(data.processes, "memory");
  document.querySelector("#cpu-explanation").textContent = cpu
    ? cpu.application +
      " is currently using the most CPU at " +
      percent(cpu.cpu) +
      " across " +
      cpu.count +
      " process" +
      (cpu.count === 1 ? "" : "es") +
      "."
    : "No process data available.";
  document.querySelector("#memory-explanation").textContent = mem
    ? mem.application +
      " is using the most resident memory at " +
      bytes(mem.memory) +
      " across " +
      mem.count +
      " process" +
      (mem.count === 1 ? "" : "es") +
      ". Resident memory totals can include shared pages, so use them to compare processes rather than add them to Memory Used."
    : "No process data available.";
}
function renderHistory(data) {
  const todayTotal = data.today.receivedBytes + data.today.sentBytes,
    monthTotal = data.month.receivedBytes + data.month.sentBytes,
    last30Total = data.last30Days.receivedBytes + data.last30Days.sentBytes,
    owners = data.connectionOwners
      .map((owner) => owner.application + " (" + owner.connections + ")")
      .join(", ");
  document.querySelector("#history-today-down").textContent = bytes(
    data.today.receivedBytes,
  );
  document.querySelector("#history-today-up").textContent = bytes(
    data.today.sentBytes,
  );
  document.querySelector("#history-month").textContent = bytes(monthTotal);
  document.querySelector("#history-last-30").textContent = bytes(last30Total);
  document.querySelector("#history-days").innerHTML = historyRows(data.daily);
  document.querySelector("#history-explanation").textContent =
    "Today: " +
    bytes(todayTotal) +
    " total traffic. Top live connection owners: " +
    (owners || "none") +
    ". Minute detail is retained for " +
    data.detailedRetentionDays +
    " days; daily totals are retained for " +
    data.dailyRetentionDays +
    " days.";
}
let storageData;
const storageExpanded = new Set(["/home/workspace"]);
const storageSearchExpanded = new Set();
let storageSearchQuery = "";
function storageRows(locations, inventoryBytes) {
  const byPath = new Map(locations.map((location) => [location.path, location]));
  const children = new Map();
  const parents = new Map();
  for (const location of locations) {
    let parent = location.path.slice(0, location.path.lastIndexOf("/"));
    while (parent && !byPath.has(parent)) parent = parent.slice(0, parent.lastIndexOf("/"));
    parents.set(location.path, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(location);
  }
  const query = document.querySelector("#storage-search").value.trim().toLowerCase();
  const matched = new Set();
  if (query) for (const location of locations) {
    if (!(location.name + " " + location.path).toLowerCase().includes(query)) continue;
    let path = location.path;
    while (path) { matched.add(path); path = parents.get(path); }
  }
  if (query !== storageSearchQuery) {
    storageSearchQuery = query;
    storageSearchExpanded.clear();
    for (const path of matched) storageSearchExpanded.add(path);
  }
  const expandedPaths = query ? storageSearchExpanded : storageExpanded;
  const ordered = [];
  function visit(parent, depth) {
    const siblings = (children.get(parent) || []).slice().sort(
      (a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name),
    );
    for (const location of siblings) {
      if (query && !matched.has(location.path)) continue;
      ordered.push({ ...location, depth, parent });
      if (expandedPaths.has(location.path)) visit(location.path, depth + 1);
    }
  }
  visit("", 0);
  return ordered.map((location) => {
    const nested = children.get(location.path) || [];
    const expanded = expandedPaths.has(location.path);
    const share = location.bytes / (byPath.get(location.parent)?.bytes || inventoryBytes || 1) * 100;
    const button = nested.length
      ? '<button type="button" class="storage-toggle" data-path="' + escape(location.path) +
        '" aria-expanded="' + expanded + '" aria-label="' + (expanded ? "Collapse " : "Expand ") +
        escape(location.name) + '">' + (expanded ? "▾" : "▸") + '</button>'
      : '<span class="storage-leaf" aria-hidden="true">·</span>';
    return '<tr data-storage-depth="' + location.depth + '"><td class="storage-location" style="--storage-depth:' +
      location.depth + '"><div class="storage-folder">' + button + '<div><strong>' + escape(location.name) +
      '</strong><span title="' + escape(location.path) + '">' + escape(location.path) +
      '</span></div></div></td><td class="storage-size" title="' + location.bytes.toLocaleString("en-GB") +
      ' bytes">' + bytes(location.bytes) + '</td><td><span class="storage-share">' + percent(share) +
      '</span></td><td class="storage-description">' +
      escape(location.description || (nested.length ? nested.length + " subfolders shown" : "Contents included in size")) +
      '</td></tr>';
  }).join("") || '<tr><td colspan="4" class="empty-row">No matching folders in this scan.</td></tr>';
}
document.querySelector("#storage-locations").addEventListener("click", (event) => {
  const button = event.target.closest(".storage-toggle");
  if (!button || !storageData?.inventory) return;
  const path = button.dataset.path;
  const expandedPaths = storageSearchQuery ? storageSearchExpanded : storageExpanded;
  if (expandedPaths.has(path)) expandedPaths.delete(path); else expandedPaths.add(path);
  const scroll = document.querySelector("#storage-panel .table-scroll");
  const top = scroll.scrollTop;
  document.querySelector("#storage-locations").innerHTML = storageRows(storageData.inventory.locations, storageData.inventory.bytes);
  scroll.scrollTop = top;
  document.querySelectorAll(".storage-toggle").forEach((item) => {
    if (item.dataset.path === path) item.focus({ preventScroll: true });
  });
});
document.querySelector("#storage-search").addEventListener("input", () => {
  if (storageData) renderStorage(storageData);
});
document.querySelector("#storage-collapse").addEventListener("click", () => {
  const expandedPaths = storageSearchQuery ? storageSearchExpanded : storageExpanded;
  expandedPaths.clear();
  if (storageData) renderStorage(storageData);
});
const storageCoverage = document.querySelector("#storage-coverage");
document.querySelector("#storage-included").addEventListener("click", () => {
  storageCoverage.showModal();
});
document.querySelector("#storage-coverage-close").addEventListener("click", () => {
  storageCoverage.close();
});
storageCoverage.addEventListener("click", (event) => {
  if (event.target !== storageCoverage) return;
  const bounds = storageCoverage.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) storageCoverage.close();
});
document.querySelector("#storage-rescan").addEventListener("click", async () => {
  const button = document.querySelector("#storage-rescan");
  button.disabled = true;
  button.textContent = "Starting scan…";
  try {
    const response = await fetch(base + "/api/storage/rescan", {
      method: "POST", headers: { Accept: "application/json", "X-Usage-Action": "rescan" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    renderStorage(await response.json());
  } catch {
    document.querySelector("#storage-explanation").textContent = "Could not start a scan. Try again.";
    document.querySelector("#storage-explanation").hidden = false;
  } finally {
    button.disabled = Boolean(storageData?.refreshing);
    button.textContent = button.disabled ? "Scanning…" : "Rescan now";
  }
});
function renderStorage(data) {
  storageData = data;
  const rescan = document.querySelector("#storage-rescan");
  rescan.disabled = Boolean(data.refreshing);
  rescan.textContent = data.refreshing ? "Scanning…" : "Rescan now";
  if (!data.inventory) {
    document.querySelector("#storage-inventory-total").textContent =
      data.status === "error" ? "Unavailable" : "Scanning...";
    document.querySelector("#storage-inventory-detail").textContent =
      "No completed scan yet";
    document.querySelector("#storage-explanation").textContent =
      data.status === "error"
        ? "The storage scan could not finish. Retrying automatically."
        : "Scanning storage in the background. Results will appear automatically; other tabs remain available.";
    document.querySelector("#storage-explanation").hidden = false;
    return;
  }
  const { inventory, filesystem } = data;
  const largest = inventory.categories[0];
  document.querySelector("#storage-bar").innerHTML = inventory.categories
    .map(
      (category) =>
        '<i title="' +
        escape(category.name + ": " + bytes(category.bytes)) +
        '" style="flex-grow:' +
        category.bytes +
        ";background:" +
        category.color +
        '"></i>',
    )
    .join("");
  document.querySelector("#storage-legend").innerHTML = inventory.categories
    .map(
      (category) =>
        '<span><i style="background:' +
        category.color +
        '"></i>' +
        escape(category.name) +
        " <b>" +
        bytes(category.bytes) +
        "</b></span>",
    )
    .join("");
  const folderTable = document.querySelector("#storage-locations");
  const folderRows = storageRows(inventory.locations, inventory.bytes);
  if (folderTable.innerHTML !== folderRows) folderTable.innerHTML = folderRows;
  document.querySelector("#storage-inventory-total").textContent = bytes(
    inventory.bytes,
  );
  document.querySelector("#storage-inventory-detail").textContent =
    "Last scanned " + new Date(data.updatedAt).toLocaleString("en-SG", {
      timeZone: "Asia/Singapore", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }) + " SGT" + (data.refreshing ? " · Scanning…" : data.stale ? " · Update overdue" : "");
  document.querySelector("#storage-location-count").textContent =
    inventory.locations.length;
  document.querySelector("#storage-largest-category").textContent = largest
    ? largest.name
    : "--";
  document.querySelector("#storage-filesystem-total").textContent = bytes(
    filesystem.total,
  );
  document.querySelector("#storage-filesystem-used").textContent = bytes(
    filesystem.used,
  );
  document.querySelector("#storage-filesystem-free").textContent = filesystem.comparable ? bytes(filesystem.available) : "N/A";
  document.querySelector("#storage-rescan-cadence").textContent =
    data.scanIntervalMinutes + " min";
  const storageExplanation = document.querySelector("#storage-explanation");
  storageExplanation.textContent = "";
  storageExplanation.hidden = !data.error && !data.incomplete;
  if (data.error) {
    document.querySelector("#storage-explanation").textContent +=
      " Refresh failed; showing the last completed scan and retrying automatically.";
  }
  if (data.incomplete) {
    document.querySelector("#storage-explanation").textContent +=
      " Some files could not be read; sizes may be incomplete.";
  }
}
function renderApplications(data) {
  const selected = Boolean(data.application),
    totals = trafficTotals(selected ? data.daily : data.applications),
    live =
      data.processes.length +
      " process" +
      (data.processes.length === 1 ? "" : "es") +
      " and " +
      data.connections.length +
      " open connection" +
      (data.connections.length === 1 ? "" : "s");
  document.querySelector("#applications-title").textContent = selected
    ? data.application
    : "Application traffic";
  document.querySelector("#applications-note").textContent = selected
    ? "daily routed traffic and live details"
    : "routed HTTP traffic, last 30 days";
  document.querySelector("#application-back").hidden = !selected;
  document.querySelector("#application-summary-one-label").textContent =
    selected ? "Live now" : "Applications";
  document.querySelector("#application-summary-one").textContent = selected
    ? live
    : data.applications.length;
  document.querySelector("#application-summary-down").textContent = bytes(
    totals.receivedBytes,
  );
  document.querySelector("#application-summary-up").textContent = bytes(
    totals.sentBytes,
  );
  document.querySelector("#application-summary-requests").textContent =
    totals.requestCount.toLocaleString();
  document.querySelector("#application-table-head").innerHTML = selected
    ? "<tr><th>Date</th><th>Received</th><th>Sent</th><th>Total traffic</th><th>Requests</th><th>Errors</th></tr>"
    : "<tr><th>Application</th><th>Received</th><th>Sent</th><th>Total traffic</th><th>Requests</th><th>Errors</th></tr>";
  document.querySelector("#application-traffic").innerHTML = selected
    ? applicationDailyRows(data.daily)
    : applicationRows(data.applications);
  document.querySelector("#applications-explanation").textContent = selected
    ? "Live detail: " +
      live +
      ". This is HTTP traffic observed at Zo Router; it does not include non-HTTP outbound traffic."
    : "Select an application to inspect its retained traffic alongside its live processes and connections. Traffic is aggregated once per minute; URLs, IP addresses, and request logs are not retained.";
}
async function refreshApplications() {
  try {
    const query = selectedApplication
      ? "?application=" + encodeURIComponent(selectedApplication)
      : "";
    const response = await fetch(base + "/api/application-history" + query, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    renderApplications(await response.json());
  } catch {
    document.querySelector("#applications-explanation").textContent =
      "Unable to read application traffic history.";
  }
}
let storageRequestPending = false;
async function refreshStorage() {
  if (storageRequestPending) return;
  storageRequestPending = true;
  try {
    const response = await fetch(base + "/api/storage", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    renderStorage(await response.json());
  } catch {
    document.querySelector("#storage-explanation").textContent =
      "Unable to refresh the storage inventory. Retrying automatically.";
  } finally {
    storageRequestPending = false;
  }
}
async function refreshHistory() {
  try {
    const response = await fetch(base + "/api/history", { cache: "no-store" });
    if (!response.ok) throw new Error();
    renderHistory(await response.json());
  } catch {
    document.querySelector("#history-explanation").textContent =
      "Unable to read retained bandwidth history.";
  }
}
async function refresh() {
  try {
    const response = await fetch(base + "/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    render(data);
    renderDetails(data);
  } catch {
    document.querySelector("#updated").textContent =
      "Unable to read host metrics";
  }
}
refresh();
setInterval(refresh, 5000);
setInterval(() => { if (activeTab === "storage") refreshStorage(); }, 5000);
