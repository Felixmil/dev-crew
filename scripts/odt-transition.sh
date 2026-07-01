#!/usr/bin/env bash
# Usage: odt-transition.sh <issue-number> <to-label>
# Reads the issue's current status:* label, checks it against the
# transition table below, and only then rewrites the label.
#
# Copy this file into a target repo's scripts/ directory. No agent
# in this plugin is allowed to call `gh issue edit --add-label`
# directly; this script is the only thing that moves the state
# machine, so an illegal transition fails loudly instead of quietly
# corrupting the issue's status.
set -euo pipefail

issue="$1"
to="$2"

current=$(gh issue view "$issue" --json labels \
  --jq '.labels[].name | select(startswith("status:"))')

is_task=$(gh issue view "$issue" --json labels \
  --jq '[.labels[].name] | any(. == "type:task" or . == "type:bug")')

allowed() {
  case "$current -> $to" in
    "status:open -> status:spec-ready") return 0 ;;
    "status:open -> status:in-progress") [[ "$is_task" == "true" ]] ;;
    "status:spec-ready -> status:ready-for-dev") return 0 ;;
    "status:spec-ready -> status:in-progress") [[ "$is_task" == "true" ]] ;;
    "status:ready-for-dev -> status:in-progress") return 0 ;;
    "status:in-progress -> status:ai-review") return 0 ;;
    "status:in-progress -> status:human-review") return 0 ;;
    "status:in-progress -> status:blocked") return 0 ;;
    "status:blocked -> status:in-progress") return 0 ;;
    "status:ai-review -> status:in-progress") return 0 ;;
    "status:ai-review -> status:human-review") return 0 ;;
    "status:human-review -> status:in-progress") return 0 ;;
    "status:human-review -> status:closed") return 0 ;;
    *) return 1 ;;
  esac
}

if ! allowed; then
  echo "Transition not allowed: $current -> $to" >&2
  exit 1
fi

gh issue edit "$issue" --remove-label "$current" --add-label "$to"
