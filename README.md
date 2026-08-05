# Zo Usage

A focused, private host-usage dashboard for Zo Computer. It provides live CPU, memory, storage, disk activity, network traffic, process attribution, and application-owned socket visibility.

The dashboard is a single Bun server. It is prefix-aware through `APP_BASE_PATH` and is normally served by Zo Router at `/usage`.

## Run locally

```bash
bun run server.ts
```

By default it listens on port `8791` and serves the dashboard at `http://127.0.0.1:8791/usage/`.

## Environment

- `PORT`: Server port. Defaults to `8791`.
- `APP_BASE_PATH`: URL path where the dashboard is mounted. Defaults to `/usage`.

The dashboard reads Linux process and system counters directly from `/proc`, cgroup accounting, and `ss`. Some host-level counters are unavailable in containers; the UI labels those cases clearly rather than estimating them.
