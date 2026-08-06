# Zo Usage

`zo-usage` is a focused, private host-usage dashboard for Zo Computer. It answers the practical operator question: **which application is using this machine's CPU, memory, disk, or network right now?**

It is intentionally a small, dependency-free Bun server rather than a general-purpose monitoring platform. It reads Linux counters directly and maps child processes back to named Zo services and applications.

## What It Shows

- **Summary:** current CPU, memory, disk capacity, network throughput, and refresh time.
- **CPU:** per-application CPU usage, process IDs, memory footprint, and disk activity.
- **Memory:** Activity Monitor-style pressure, physical/used/available memory, file cache, shared memory, swap, process resident memory, and thread counts.
- **Disk:** root-volume capacity plus per-process read/write rates and cumulative process I/O.
- **Network:** interface-wide transfer and packet rates, total traffic, open/listening sockets, and socket ownership by application.
- **Attribution:** familiar application names such as OpenClaw, Zo Drive, ZoTube, Zo Moments, ZoMinAI Runtime, Codex, Zo Browser, and Zo Router instead of unexplained `bun` or `node` processes.

The page is designed for a single desktop viewport: the application page does not scroll, while process tables have their own scroll area and sticky headers.

## Architecture

```text
Browser
  -> private-apps gateway at /usage/
  -> zo-usage on 127.0.0.1:8791
  -> /proc, /sys/fs/cgroup, df, and ss
```

The dashboard is mounted at a path rather than the domain root. `APP_BASE_PATH` makes the HTML, API, and favicon prefix-aware, so the router can pass `/usage/*` through unchanged.

## Requirements

- Linux host or container with `/proc` mounted.
- Bun 1.x.
- `df` and `ss` available on `PATH`.
- Permission to inspect processes and sockets. Running it as the same privileged account that runs Zo services gives the best attribution.
- A reverse proxy if the dashboard should be accessed outside the local machine.

No npm packages, database, build step, or external telemetry account are required.

## Local Run

```bash
git clone https://github.com/sayyidkhan/zo-usage.git
cd zo-usage
bun run server.ts
```

The default address is `http://127.0.0.1:8791/usage/`. The first CPU and throughput values can be `0` until a second sample is collected; the browser refreshes automatically every five seconds.

For a different local port or mount path:

```bash
PORT=9000 APP_BASE_PATH=/monitor bun run server.ts
```

Open `http://127.0.0.1:9000/monitor/` in that case.

## Deploy On Zo

Use a Zo **process** service, not a public HTTP service. This keeps host telemetry reachable only through the private gateway.

Create or update a service with these values:

| Setting | Value |
| --- | --- |
| Name | `zo-usage` |
| Working directory | `/home/workspace/Start/garden-of-zo/zo-usage` |
| Entrypoint | `bun run server.ts` |
| Service mode | `process` |
| `PORT` | `8791` |
| `APP_BASE_PATH` | `/usage` |

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

Check the local data endpoint first:

```bash
curl --fail http://127.0.0.1:8791/usage/api/snapshot
```

It should return JSON with `cpu`, `memory`, `disk`, `network`, `processes`, and `connections`. Then open the routed `/usage/` URL and confirm all four tabs load. If the API works locally but the browser does not, inspect the private-router route prefix and restart `private-apps`.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8791` | Loopback port used by the Bun server. |
| `APP_BASE_PATH` | `/usage` | URL path served by the dashboard. Do not include a trailing slash. |
| `APPLICATION_MANIFEST_PATH` | Unset | Optional absolute path to a JSON manifest merged over the bundled application labels. |

## Data Sources And Limits

| Area | Source | Notes |
| --- | --- | --- |
| CPU | cgroup `cpuacct.usage`, then `/proc/stat` | Uses cgroup accounting when `/proc/stat` is zeroed by a container. |
| Memory | `/proc/meminfo` and process status | Process resident totals can include shared pages, so they do not necessarily equal used memory. |
| Disk capacity | `df -B1 /` | Reports the dashboard container's root volume. |
| Process disk I/O | `/proc/<pid>/io` | Shows activity of visible processes; host block-device totals may not be available inside Zo. |
| Network totals | `/proc/net/dev` | Interface-wide totals and rates, excluding loopback. |
| Socket ownership | `ss` plus `/proc/<pid>/fd` | Linux does not expose reliable per-process network byte totals here, so traffic totals are intentionally interface-wide. |

When a counter is unavailable in the container, the dashboard shows `N/A` or explains the limitation instead of fabricating a value.

## Application Attribution

The resolver identifies managed Zo service parents, process command lines, and working directories. Friendly service labels live in `application-manifest.json`, not in application code.

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

Edit the bundled manifest when you want to share the labels with the deployment. For local labels that should survive `git pull`, copy it to `application-manifest.local.json`, edit it, and configure the service with:

```text
APPLICATION_MANIFEST_PATH=/home/workspace/Start/garden-of-zo/zo-usage/application-manifest.local.json
```

The override manifest is merged over bundled labels, so it can contain only new services or label replacements. It is ignored by Git. Restart `zo-usage` after changing either manifest. Invalid manifests are logged and safely ignored; the dashboard continues using the bundled labels. When no match exists, the dashboard falls back to a clear platform/runtime label.

## Update Workflow

```bash
cd /home/workspace/Start/garden-of-zo/zo-usage
git pull --ff-only
bun build server.ts --target=bun --outfile=/tmp/zo-usage-check.js
```

Restart the `zo-usage` service to load the new server code. If the update changes the routing behaviour or `APP_BASE_PATH`, also restart `private-apps`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| CPU stays at `0%` | First sample has no baseline, or `/proc/stat` is virtualised | Wait one refresh. The server automatically prefers cgroup CPU accounting when available. |
| Dashboard loads but tables are empty | Process/socket inspection is restricted | Run the service with sufficient process visibility and check `/proc` is mounted. |
| `/usage/` returns 404 | Missing or stale private-router route | Add the `/usage` route without prefix stripping, then restart `private-apps`. |
| API works on port `8791` but the routed page fails | `APP_BASE_PATH` and router prefix differ | Set both to `/usage` and restart `zo-usage`. |
| Disk I/O is always zero | No visible process is doing disk I/O, or container counters are restricted | Generate normal workload and wait one refresh. Do not infer host-wide device activity from zero. |
| Network data does not map to an app | Linux only exposes socket ownership, not process byte counters | Use the socket table to identify the owner; read/write totals remain interface-wide. |

## Security

This dashboard exposes operational information: process names, PIDs, running applications, listening ports, socket endpoints, and host resource usage. Keep it behind Zo Router's private gateway or another authenticated reverse proxy. Do not expose the service port directly to the internet.
