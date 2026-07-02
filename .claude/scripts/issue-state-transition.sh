#!/usr/bin/env bash
# Usage: issue-state-transition.sh <issues-root> <issue> <to-status>
# Reads the issue's current status from <issues-root>/<issue>/state.json,
# checks the current -> to edge against the transition table below, and
# only then rewrites the "status" field in place, leaving every other
# field untouched.
#
# Copy this file into a target repo's .claude/scripts/ directory. No
# agent or skill in this plugin is allowed to write state.json's
# "status" field directly; this script is the only thing that moves the
# state machine, so an illegal transition fails loudly instead of
# quietly corrupting the issue's state.
#
# Only the storage changed from the label-based transition: the state
# lives in a local state.json field, bare (no "status:" prefix), rather
# than in a GitHub status:* label. The edge set is identical.
#
# The four *-awaiting-approval statuses are gates used only in the
# skill's manual mode. A gate is entered from the status that precedes a
# phase and, once a human approves, exits to the exact real status that
# phase's output would have produced in auto mode. Auto/semi-auto mode
# never touches these statuses.
set -euo pipefail

issues_root="$1"
issue="$2"
to="$3"

state_file="$issues_root/$issue/state.json"

# Current status from state.json; a missing file or missing/null field
# is treated as "open" (a freshly bootstrapped issue).
if [[ -f "$state_file" ]]; then
  current=$(jq -r '.status // "open"' "$state_file")
else
  current="open"
fi

# The type:task/type:bug signal is read from GitHub (read-only), exactly
# as the label-based transition did: the skip-spec shortcut still reads
# the type labels, and writes nothing back.
is_task=$(gh issue view "$issue" --json labels \
  --jq '[.labels[].name] | any(. == "type:task" or . == "type:bug")')

# Transition table, transcribed verbatim from OpenDucktor's
# status-transition-policy.ts (the same table the label-based transition
# enforced), with the "status:" prefix stripped consistently on both
# sides of every edge. The edge set is byte-identical modulo that strip.
allowed() {
  case "$current -> $to" in
    "open -> spec-ready") return 0 ;;
    "open -> in-progress") [[ "$is_task" == "true" ]] ;;
    "open -> spec-awaiting-approval") return 0 ;;
    "spec-awaiting-approval -> spec-ready") return 0 ;;
    "spec-ready -> ready-for-dev") return 0 ;;
    "spec-ready -> in-progress") [[ "$is_task" == "true" ]] ;;
    "spec-ready -> plan-awaiting-approval") return 0 ;;
    "plan-awaiting-approval -> ready-for-dev") return 0 ;;
    "ready-for-dev -> in-progress") return 0 ;;
    "ready-for-dev -> build-awaiting-approval") return 0 ;;
    "in-progress -> ai-review") return 0 ;;
    "in-progress -> human-review") return 0 ;;
    "in-progress -> blocked") return 0 ;;
    "in-progress -> build-awaiting-approval") return 0 ;;
    "build-awaiting-approval -> ai-review") return 0 ;;
    "blocked -> in-progress") return 0 ;;
    "ai-review -> in-progress") return 0 ;;
    "ai-review -> human-review") return 0 ;;
    "ai-review -> qa-awaiting-approval") return 0 ;;
    "qa-awaiting-approval -> human-review") return 0 ;;
    "qa-awaiting-approval -> in-progress") return 0 ;;
    "human-review -> in-progress") return 0 ;;
    "human-review -> closed") return 0 ;;
    *) return 1 ;;
  esac
}

if ! allowed; then
  echo "Transition not allowed: $current -> $to" >&2
  exit 1
fi

# Write only the "status" field, leaving every other field untouched.
# state.json must already exist (the skill bootstraps it as {"status":
# "open", ...} before the first transition); refuse rather than invent a
# fresh file, since a legal transition out of "open" implies the file
# was already seeded.
if [[ ! -f "$state_file" ]]; then
  echo "State file not found: $state_file" >&2
  exit 1
fi

# Temp-file-plus-rename so a session killed mid-write cannot leave a torn
# state.json. The temp file is created as a sibling so the rename is
# atomic (same filesystem).
tmp_file=$(mktemp "$issues_root/$issue/.state.json.XXXXXX")
trap 'rm -f "$tmp_file"' EXIT
jq --arg to "$to" '.status = $to' "$state_file" >"$tmp_file"
mv "$tmp_file" "$state_file"
trap - EXIT
