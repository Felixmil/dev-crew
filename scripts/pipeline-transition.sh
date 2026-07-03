#!/usr/bin/env bash
# Usage: pipeline-transition.sh <issues-root> <issue> <to-status>
# Reads the issue's current status from <issues-root>/<issue>/state.json,
# checks the current -> to edge against the transition table below, and
# only then rewrites the "status" field in place, leaving every other
# field untouched.
#
# A transition to the status already in effect is an idempotent no-op:
# it exits 0 without rewriting the file (see the guard below). This makes
# re-applying the same transition harmless, so a caller that re-enters a
# phase and re-issues its transition does not crash on an X -> X edge the
# table does not list. Every genuinely different edge still goes through
# the table and a disallowed one fails loudly.
#
# This script ships INSIDE the plugin (at scripts/pipeline-transition.sh)
# and both pipeline skills invoke it via the plugin-root path variable,
# `bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh" ...`, so it
# never needs copying into a target repo. No agent or skill is allowed to
# write state.json's "status" field directly; this script is the only
# thing that moves the state machine, so an illegal transition fails
# loudly instead of quietly corrupting the issue's state.
#
# State lives entirely in the local state.json (status is a bare field, no
# "status:" prefix). Nothing here reads or writes a GitHub label, so both
# pipelines work in repos where status:* labels are unavailable or
# uncreatable. The edge set is transcribed from OpenDucktor's transition
# policy, minus the task/bug skip-spec fast-path (every issue runs the
# full spec -> plan -> build -> QA path).
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

# Idempotent no-op: a transition to the status the machine is already at
# is "already there", not an error. This makes a double-apply of the same
# transition harmless, which matters because a caller can re-enter a phase
# and re-issue its transition (e.g. after a stale-read replay on resume) and
# would otherwise crash on an X -> X edge the table does not list. Only an
# EXACT no-op is short-circuited; every genuinely different edge, including
# every real illegal one, still goes through the table below and fails loudly.
# Reported on stderr so a no-op is visible, not silent, and the file is left
# untouched (no rewrite, so no chance of corrupting an already-correct state).
if [[ "$current" == "$to" ]]; then
  echo "Already at $to; no-op transition." >&2
  exit 0
fi

# Transition table, transcribed from OpenDucktor's
# status-transition-policy.ts, with the "status:" prefix stripped
# consistently on both sides of every edge. Every issue runs the full
# spec -> plan -> build -> QA path; there is no task/bug skip-spec
# shortcut (the old open/spec-ready -> in-progress fast-path edges are
# intentionally omitted).
allowed() {
  case "$current -> $to" in
    "open -> spec-ready") return 0 ;;
    "open -> spec-awaiting-approval") return 0 ;;
    "spec-awaiting-approval -> spec-ready") return 0 ;;
    "spec-ready -> ready-for-dev") return 0 ;;
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
