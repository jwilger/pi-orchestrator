#!/usr/bin/env bash
set -euo pipefail

slice="${1:?slice id required (e.g. S1)}"
title="${2:?pr title required}"

state_dir=".orchestra/runtime/pr"
state_file="$state_dir/${slice}.json"

mkdir -p "$state_dir"

bash scripts/orchestra/precheck.sh
bash scripts/orchestra/sync-main.sh

if git diff --quiet && git diff --cached --quiet; then
  echo "no changes to commit for $slice" >&2
  exit 1
fi

branch="orchestra/${slice,,}-$(date +%Y%m%d%H%M%S)"

git checkout -b "$branch"
git add -A
git commit -m "$slice: autonomous slice implementation"
git push -u origin "$branch"

body_file="/tmp/orchestra-pr-${slice}.md"
cat > "$body_file" <<EOF
## $slice
Autonomous slice delivery by Orchestra.

- Source of truth: docs/SLICES.md
- Workflow: orchestra-self-host-panel
EOF

pr_url="$(gh pr create --base main --head "$branch" --title "$title" --body-file "$body_file")"
pr_number="${pr_url##*/}"

python - <<PY
import json
from pathlib import Path
Path("$state_file").write_text(json.dumps({
  "slice": "$slice",
  "branch": "$branch",
  "title": "$title",
  "pr": int("$pr_number"),
  "url": "$pr_url",
  "status": "open"
}, indent=2) + "\n")
PY

printf '%s\n' "$pr_url"
