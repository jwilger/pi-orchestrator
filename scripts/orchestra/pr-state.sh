#!/usr/bin/env bash
set -euo pipefail

slice="${1:?slice id required}"
expected="${2:?expected status required (open|ready|merged)}"
state_file=".orchestra/runtime/pr/${slice}.json"

if [[ ! -f "$state_file" ]]; then
  echo "missing state file: $state_file" >&2
  exit 1
fi

actual="$(python - <<PY
import json
print(json.load(open("$state_file"))["status"])
PY
)"

if [[ "$actual" != "$expected" ]]; then
  echo "expected status '$expected' but got '$actual' for $slice" >&2
  exit 1
fi

echo "$slice status=$actual"
