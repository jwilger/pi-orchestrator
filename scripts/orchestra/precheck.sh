#!/usr/bin/env bash
set -euo pipefail

command -v git >/dev/null
command -v gh >/dev/null
command -v npm >/dev/null

if ! gh auth status >/dev/null 2>&1; then
  echo "gh auth not configured" >&2
  exit 1
fi

git rev-parse --is-inside-work-tree >/dev/null
