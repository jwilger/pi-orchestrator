#!/usr/bin/env bash
set -euo pipefail

slice="${1:?slice id required}"
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

gh pr merge "$pr_number" --squash --delete-branch

python - <<PY
import json
from pathlib import Path
path = Path("$state_file")
data = json.loads(path.read_text())
data["status"] = "merged"
path.write_text(json.dumps(data, indent=2) + "\n")
PY

bash scripts/orchestra/sync-main.sh
