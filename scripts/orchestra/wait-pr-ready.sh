#!/usr/bin/env bash
set -euo pipefail

slice="${1:?slice id required}"
timeout_seconds="${2:-10800}"

state_file=".orchestra/runtime/pr/${slice}.json"

if [[ ! -f "$state_file" ]]; then
  echo "missing state file: $state_file" >&2
  exit 1
fi

pr_number="$(python - <<PY
import json
print(json.load(open("$state_file"))["pr"])
PY
)"

deadline=$(( $(date +%s) + timeout_seconds ))

while true; do
  output_file="/tmp/orchestra-pr-checks-${slice}.txt"
  set +e
  gh pr checks "$pr_number" >"$output_file" 2>&1
  code=$?
  set -e

  if [[ "$code" -eq 0 ]]; then
    python - <<PY
import json
from pathlib import Path
path = Path("$state_file")
data = json.loads(path.read_text())
data["status"] = "ready"
path.write_text(json.dumps(data, indent=2) + "\n")
PY
    exit 0
  fi

  if grep -Eq "\bfail\b|\bcancel\b" "$output_file"; then
    echo "PR checks failed for #$pr_number" >&2
    cat "$output_file" >&2
    exit 1
  fi

  if [[ $(date +%s) -ge "$deadline" ]]; then
    echo "Timed out waiting for checks on #$pr_number" >&2
    cat "$output_file" >&2
    exit 1
  fi

  sleep 20
done
