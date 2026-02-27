#!/usr/bin/env bash
set -euo pipefail

bash scripts/orchestra/precheck.sh

git checkout main
git pull --ff-only origin main

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "main" ]]; then
  echo "expected main branch, got $current_branch" >&2
  exit 1
fi
