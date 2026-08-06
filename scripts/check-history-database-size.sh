#!/usr/bin/env bash
set -euo pipefail

database_path="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backend/data/usage-history.sqlite}"
threshold_bytes="${USAGE_HISTORY_ALERT_BYTES:-104857600}"
clear_threshold_bytes=$((threshold_bytes * 80 / 100))
state_path="${database_path}.alert-state"

size_bytes=0
for file in "${database_path}" "${database_path}-wal" "${database_path}-shm"; do
  if [[ -f "$file" ]]; then
    size_bytes=$((size_bytes + $(stat -c %s "$file")))
  fi
done

if ((size_bytes >= threshold_bytes)); then
  if [[ ! -f "$state_path" ]]; then
    printf '%s\n' "$size_bytes" > "$state_path"
    printf 'ALERT history database is %s bytes (threshold: %s bytes)\n' "$size_bytes" "$threshold_bytes"
  else
    printf 'ALREADY_ALERTED history database is %s bytes\n' "$size_bytes"
  fi
elif [[ -f "$state_path" ]] && ((size_bytes < clear_threshold_bytes)); then
  rm -f "$state_path"
  printf 'REARMED history database is %s bytes\n' "$size_bytes"
else
  printf 'OK history database is %s bytes\n' "$size_bytes"
fi
