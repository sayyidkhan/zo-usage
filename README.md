# Zo Usage

`zo-usage` is a focused, private host-usage dashboard for Zo Computer. It answers the practical operator question: **which application is using this machine's CPU, memory, disk, or network right now?**

It is intentionally a small, dependency-free Bun server rather than a general-purpose monitoring platform. It reads Linux counters directly and maps child processes back to named Zo services and applications.

## What It Shows

- **Summary:** current CPU, memory, scanned storage for configured locations, network throughput, and refresh time. Scanned storage includes Hermes and Codex data and refreshes every five minutes; it is not whole-volume usage.
- **CPU:** per-application CPU usage, process IDs, memory footprint, and disk activity.
- **Memory:** Activity Monitor-style pressure, physical/used/available memory, file cache, shared memory, swap, process resident memory, and thread counts.
- **Disk:** scanned storage, explicitly labelled virtual volume counters, and per-process read/write rates and lifetime totals. A small startup file-write/read probe chooses working physical counters or logical application I/O; unsupported values and first-sample rates show `N/A`.
- **Storage:** an expandable, searchable folder tree discovered from the filesystem on each scan. Workspace follows the actual hierarchy, including Start → pal → kingdom-of-pal, with friendly labels for PAL and Garden of Zo. The seven non-overlapping scan roots cover Workspace, Zo data, OpenClaw recovery files, Hermes, Codex and tool caches. Folders are discovered up to four levels below each root; deeper contents still count towards folder sizes. Dependency/Git directories are single entries. Siblings sort by size, each parent includes its children, and percentages show each folder's share of its parent (root percentages show share of the full inventory). Search reveals matching folders and their ancestors, with working expand/collapse controls. Search expansion is separate from normal browsing and persists across data refreshes; Collapse all keeps the search text. No file contents are read by the inventory. Totals use binary units (KiB/MiB/GiB). The category breakdown, folder help, technical volume figures and coverage details open in a modal using “What is included?” beside the scan button. Close it with Close, Escape or a click outside; keyboard focus stays inside while open and returns to the button when closed. The last completed scan time appears in SGT, alongside scanning/overdue/error status. Scans run every five minutes; Rescan now starts a background scan with one concurrent traversal, a 30-second minimum between manual starts and failure backoff. Results persist in SQLite across restarts. New, renamed and deleted directories appear after a completed scan, rather than as live file events.
- **Network:** interface-wide transfer and packet rates, total traffic, open/listening sockets, and socket ownership by application.
- **History:** durable interface-wide bandwidth totals for today, this month, and the last 30 days, with a daily record retained for one year.
- **Apps:** click an application to drill into its routed HTTP traffic, daily totals, current child processes, and open connections.
- **Attribution:** familiar application names such as OpenClaw, Zo Drive, ZoTube, Zo Moments, ZoMinAI Runtime, Codex, Zo Browser, and Zo Router instead of unexplained `bun` or `node` processes.

The desktop process views fit a single viewport with scrolling tables and sticky headers. The Usage heading is 32px on desktop and 28px on mobile. All views, including Storage, show the four host overview cards by default. The header’s “Hide overview” / “Show overview” button frees space above the resource tabs; the choice applies across tabs and is remembered in this browser. Storage also uses a compact total, scan timestamp and action row above the folder browser. It allows page scrolling on shorter screens; the folder table has its own bounded scroll area. On narrow screens, the page scrolls normally, the tab row can be swiped sideways, and process tables retain their own scroll area.

## Architecture

```text
Browser
  -> private-apps gateway at /usage/
  -> zo-usage on 127.0.0.1:8791
  -> /proc, /sys/fs/cgroup, df, ss, and local SQLite history

private-apps and public-apps
  -> minute-level route aggregates
  -> zo-usage local collector
```

## Project Layout

```text
backend/
  server.ts                  # Metrics collector, API, and static asset delivery
  application-manifest.json  # Shared Zo service-name labels
  data/                      # Generated local SQLite bandwidth history (ignored by Git)
frontend/
  index.html                 # Dashboard structure
  styles.css                 # Dashboard styles
  app.js                     # Tabs, refresh, and rendering
  favicon.svg                # Browser icon
```

The backend injects the configured `APP_BASE_PATH` into the frontend assets at request time. This keeps `/usage` routing portable while leaving the browser UI independent of the telemetry collector.

The dashboard is mounted at a path rather than the domain root. `APP_BASE_PATH` makes the HTML, API, and favicon prefix-aware, so the router can pass `/usage/*` through unchanged.

## Requirements

- Linux host or container with `/proc` mounted.
- Bun 1.x.
- `df` and `ss` available on `PATH`.
- Permission to inspect processes and sockets. Running it as the same privileged account that runs Zo services gives the best attribution.
- A reverse proxy if the dashboard should be accessed outside the local machine.

No npm packages, build step, or external telemetry account are required. Bun's built-in SQLite stores the small local bandwidth history.

## Local Run

```bash
git clone https://github.com/sayyidkhan/zo-usage.git
cd zo-usage
bun run backend/server.ts
```

The default address is `http://127.0.0.1:8791/usage/`. The first CPU and throughput values can be `0` until a second sample is collected; the browser refreshes automatically every five seconds.

For a different local port or mount path:

```bash
PORT=9000 APP_BASE_PATH=/monitor bun run backend/server.ts
```

Open `http://127.0.0.1:9000/monitor/` in that case.

## Deploy On Zo

Use a Zo **process** service, not a public HTTP service. This keeps host telemetry reachable only through the private gateway.

Create or update a service with these values:

| Setting           | Value                                         |
| ----------------- | --------------------------------------------- |
| Name              | `zo-usage`                                    |
| Working directory | `/home/workspace/Start/garden-of-zo/zo-usage` |
| Entrypoint        | `bun run backend/server.ts`                   |
| Service mode      | `process`                                     |
| `PORT`            | `8791`                                        |
| `APP_BASE_PATH`   | `/usage`                                      |

The process listens on loopback at `127.0.0.1:8791`; do not create a direct public route for it.

### Route Through Zo Router

Add this route to `zo-router/private.routes.json`:

```json
{
  "prefix": "/usage",
  "label": "zo-usage",
  "targetOrigin": "http://127.0.0.1:8791"
}
```

Do **not** set `stripPrefix`: the dashboard receives `/usage/`, `/usage/api/snapshot`, and `/usage/favicon.svg` itself. Restart the `private-apps` gateway after changing its route map. The deployed dashboard is then available privately at:

`https://private-apps-sayyidkhan.zo.computer/usage/`

## Verify A Deployment

Run the storage regression checks with `bun test backend/storage.test.ts`. Run all collector regressions with `bun test backend`, including I/O fallback, missing counters, PID reuse and counter resets. They cover concurrent cold requests, persistent caching, failed refreshes with retries, and overlapping directory sizes.

Check the local data endpoint first:

```bash
curl --fail http://127.0.0.1:8791/usage/api/snapshot
```

It should return JSON with `cpu`, `memory`, `disk`, `network`, `processes`, and `connections`. Check retained bandwidth data separately:

```bash
curl --fail http://127.0.0.1:8791/usage/api/history
```

Check the cached storage inventory separately:

A manual scan uses `POST /usage/api/storage/rescan` with `X-Usage-Action: rescan`. It returns immediately with status 202; poll the normal storage endpoint for completion. The action rejects cross-site browser requests and coalesces concurrent scans.

```bash
curl --fail http://127.0.0.1:8791/usage/api/storage
```

Check router-observed application traffic:

```bash
curl --fail http://127.0.0.1:8791/usage/api/application-history
```

Then open the routed `/usage/` URL and confirm all five tabs load. If the API works locally but the browser does not, inspect the private-router route prefix and restart `private-apps`.

## Environment Variables

| Variable                      | Default                             | Purpose                                                                               |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `PORT`                        | `8791`                              | Loopback port used by the Bun server.                                                 |
| `APP_BASE_PATH`               | `/usage`                            | URL path served by the dashboard. Do not include a trailing slash.                    |
| `APPLICATION_MANIFEST_PATH`   | Unset                               | Optional absolute path to a JSON manifest merged over the bundled application labels. |
| `USAGE_HISTORY_DATABASE_PATH` | `backend/data/usage-history.sqlite` | Optional absolute path for the local SQLite bandwidth history.                        |

## Data Sources And Limits

| Area                | Source                                    | Notes                                                                                                                    |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CPU                 | cgroup `cpuacct.usage`, then `/proc/stat` | Uses cgroup accounting when `/proc/stat` is zeroed by a container.                                                       |
| Memory              | `/proc/meminfo` and process status        | Process resident totals can include shared pages, so they do not necessarily equal used memory.                          |
| Disk capacity       | `df -B1 /`                                | Reports the dashboard container's root volume.                                                                           |
| Storage inventory   | Background `du -x -B1 --max-depth` scan | Walks each category root once and discovers directory sizes to depth four from the same traversal, using NUL-delimited output for unusual names. Scans have a two-minute timeout, one concurrent scan, and automatic retries; failed refreshes preserve the saved result. |
| Process I/O | `/proc/<pid>/io` | Startup probe verifies a 64 KiB write/read. Uses physical `read_bytes`/`write_bytes` when working; otherwise verified `rchar`/`wchar`. Logical bytes include cached files, sockets and pipes and are not physical disk traffic. Missing counters remain null. Rates reset for reused PIDs and counter resets. |
| Network totals      | `/proc/net/dev`                           | Interface-wide totals and rates, excluding loopback.                                                                     |
| Bandwidth history   | Local SQLite                              | Records interface-wide byte and packet deltas once per minute.                                                           |
| Application traffic | Zo Router                                 | Aggregates HTTP request/response sizes, counts, and errors per application once per minute.                              |
| Socket ownership    | `ss` plus `/proc/<pid>/fd`                | Linux does not expose reliable per-process network byte totals here, so traffic totals are intentionally interface-wide. |

When a counter is unavailable in the container, the dashboard shows `N/A` or explains the limitation instead of fabricating a value.

Some container filesystems virtualise `df` counters, so their reported used space can be lower than the visible directory sizes. In that case, the Storage tab explicitly marks the volume counter as non-comparable and uses the scanned directory inventory for its category bar instead of presenting false free-space maths.

### Bandwidth Retention

The dashboard stores one interface-wide sample per minute. It retains minute-level samples for **30 days** and rolls their byte and packet deltas into daily totals retained for **365 days**. The generated SQLite database is ignored by Git and is normally only a few megabytes; no process lists, socket endpoints, or per-application connection history are written to disk.

The first recorded sample establishes a baseline, so the initial minute can show zero traffic. The next sample records the actual traffic since that baseline. Counter resets, such as a container restart, are safely recorded as zero rather than producing false negative usage.

Application traffic uses only the application label, minute bucket, request/response bytes, request count, and error count. It excludes URLs, client IP addresses, headers, and individual request logs. The measurement covers HTTP traffic traversing Zo Router; direct localhost traffic and arbitrary outbound protocols are not included.

### Database Size Alert

`scripts/check-history-database-size.sh` measures the SQLite database together with its WAL and shared-memory files. It reports one alert after the total reaches **100 MB**, then rearms only after it falls below **80 MB**. This prevents repeat notifications while the database remains above the threshold.

```bash
scripts/check-history-database-size.sh
```

Use `USAGE_HISTORY_ALERT_BYTES` to set a different threshold in bytes.

## Application Attribution

The resolver identifies managed Zo service parents, process command lines, and working directories. Friendly service labels live in `backend/application-manifest.json`, not in application code.

The manifest is intentionally ordinary JSON so each operator can maintain their own services:

```json
{
  "version": 1,
  "applications": {
    "my-service": "My Service",
    "worker-email": "Email Worker"
  }
}
```

Edit the bundled manifest when you want to share the labels with the deployment. For local labels that should survive `git pull`, copy it to `backend/application-manifest.local.json`, edit it, and configure the service with:

```text
APPLICATION_MANIFEST_PATH=/home/workspace/Start/garden-of-zo/zo-usage/backend/application-manifest.local.json
```

The override manifest is merged over bundled labels, so it can contain only new services or label replacements. It is ignored by Git. Restart `zo-usage` after changing either manifest. Invalid manifests are logged and safely ignored; the dashboard continues using the bundled labels. When no match exists, the dashboard falls back to a clear platform/runtime label.

## Update Workflow

```bash
cd /home/workspace/Start/garden-of-zo/zo-usage
git pull --ff-only
bun build backend/server.ts --target=bun --outfile=/tmp/zo-usage-check.js
```

Restart the `zo-usage` service to load the new server code. If the update changes the routing behaviour or `APP_BASE_PATH`, also restart `private-apps`.

## Troubleshooting

| Symptom                                            | Likely Cause                                                               | Fix                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CPU stays at `0%`                                  | First sample has no baseline, or `/proc/stat` is virtualised               | Wait one refresh. The server automatically prefers cgroup CPU accounting when available.         |
| Dashboard loads but tables are empty               | Process/socket inspection is restricted                                    | Run the service with sufficient process visibility and check `/proc` is mounted.                 |
| `/usage/` returns 404                              | Missing or stale private-router route                                      | Add the `/usage` route without prefix stripping, then restart `private-apps`.                    |
| API works on port `8791` but the routed page fails | `APP_BASE_PATH` and router prefix differ                                   | Set both to `/usage` and restart `zo-usage`.                                                     |
| Physical disk I/O unavailable | Zo does not expose working physical counters | The Disk tab shows verified application I/O instead and explains its scope. `N/A` means unavailable or waiting for a second sample. |
| Network data does not map to an app                | Linux only exposes socket ownership, not process byte counters             | Use the socket table to identify the owner; read/write totals remain interface-wide.             |

## Security

This dashboard exposes operational information: process names, PIDs, running applications, listening ports, socket endpoints, and host resource usage. Keep it behind Zo Router's private gateway or another authenticated reverse proxy. Do not expose the service port directly to the internet.
